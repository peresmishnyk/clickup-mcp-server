/**
 * SPDX-FileCopyrightText: © 2025 Talib Kareem <taazkareem@icloud.com>
 * SPDX-License-Identifier: MIT
 *
 * ClickUp Task Service - Search Module
 * 
 * Handles search and lookup operations for tasks in ClickUp, including:
 * - Finding tasks by name
 * - Global workspace task lookup
 * - Task summaries and detailed task data
 */

import { TaskServiceCore } from './task-core.js';
import {
  ClickUpTask,
  TaskFilters,
  TaskSummary,
  WorkspaceTasksResponse,
  DetailedTaskResponse,
  ExtendedTaskFilters,
  UpdateTaskData
} from '../types.js';
import { isNameMatch } from '../../../utils/resolver-utils.js';
import { findListIDByName } from '../../../tools/list.js';
import { estimateTokensFromObject, wouldExceedTokenLimit } from '../../../utils/token-utils.js';

/**
 * Search functionality for the TaskService
 *
 * This service handles all search and lookup operations for ClickUp tasks.
 * It uses composition to access core functionality instead of inheritance.
 *
 * REFACTORED: Now uses composition instead of inheritance.
 * Only depends on TaskServiceCore for base functionality.
 */
export class TaskServiceSearch {
  constructor(private core: TaskServiceCore) {}
  /**
   * Find a task by name within a specific list
   * @param listId The ID of the list to search in
   * @param taskName The name of the task to find
   * @returns The task if found, otherwise null
   */
  async findTaskByName(listId: string, taskName: string): Promise<ClickUpTask | null> {
    (this.core as any).logOperation('findTaskByName', { listId, taskName });

    try {
      const tasks = await this.core.getTasks(listId);
      return this.findTaskInArray(tasks, taskName);
    } catch (error) {
      throw (this.core as any).handleError(error, `Failed to find task by name: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Find a task by name from an array of tasks
   * @param taskArray Array of tasks to search in
   * @param name Name of the task to search for
   * @param includeDetails Whether to add list context to task
   * @returns The task that best matches the name, or null if no match
   */
  private findTaskInArray(taskArray: any[], name: string, includeDetails = false): any {
    if (!taskArray || !Array.isArray(taskArray) || taskArray.length === 0 || !name) {
      return null;
    }

    // Get match scores for each task
    const taskMatchScores = taskArray
      .map(task => {
        const matchResult = isNameMatch(task.name, name);
        return {
          task,
          matchResult,
          // Parse the date_updated field as a number for sorting
          updatedAt: task.date_updated ? parseInt(task.date_updated, 10) : 0
        };
      })
      .filter(result => result.matchResult.isMatch);

    if (taskMatchScores.length === 0) {
      return null;
    }

    // First, try to find exact matches
    const exactMatches = taskMatchScores
      .filter(result => result.matchResult.exactMatch)
      .sort((a, b) => {
        // For exact matches with the same score, sort by most recently updated
        if (b.matchResult.score === a.matchResult.score) {
          return b.updatedAt - a.updatedAt;
        }
        return b.matchResult.score - a.matchResult.score;
      });

    // Get the best matches based on whether we have exact matches or need to fall back to fuzzy matches
    const bestMatches = exactMatches.length > 0 ? exactMatches : taskMatchScores.sort((a, b) => {
      // First sort by match score (highest first)
      if (b.matchResult.score !== a.matchResult.score) {
        return b.matchResult.score - a.matchResult.score;
      }
      // Then sort by most recently updated
      return b.updatedAt - a.updatedAt;
    });

    // Get the best match
    const bestMatch = bestMatches[0].task;

    // If we need to include more details
    if (includeDetails) {
      // Include any additional details needed
    }

    return bestMatch;
  }

  /**
   * Formats a task into a lightweight summary format
   * @param task The task to format
   * @returns A TaskSummary object
   */
  protected formatTaskSummary(task: ClickUpTask): TaskSummary {
    return {
      id: task.id,
      name: task.name,
      status: task.status.status,
      list: {
        id: task.list.id,
        name: task.list.name
      },
      due_date: task.due_date,
      url: task.url,
      priority: (this.core as any).extractPriorityValue(task),
      tags: task.tags.map(tag => ({
        name: tag.name,
        tag_bg: tag.tag_bg,
        tag_fg: tag.tag_fg
      }))
    };
  }

  /**
   * Estimates token count for a task in JSON format
   * @param task ClickUp task
   * @returns Estimated token count
   */
  protected estimateTaskTokens(task: ClickUpTask): number {
    return estimateTokensFromObject(task);
  }

  /**
   * Get filtered tasks across the entire team/workspace using tags and other filters
   * @param filters Task filters to apply including tags, list/folder/space filtering
   * @returns Either a DetailedTaskResponse or WorkspaceTasksResponse depending on detail_level
   */
  async getWorkspaceTasks(filters: ExtendedTaskFilters = {}): Promise<DetailedTaskResponse | WorkspaceTasksResponse> {
    try {
      (this.core as any).logOperation('getWorkspaceTasks', { filters });

      // Strategy 1: Try direct team endpoint (may fail with certain filter combinations)
      try {
        const params = (this.core as any).buildTaskFilterParams(filters);
        const response = await (this.core as any).makeRequest(async () => {
          return await (this.core as any).client.get(`/team/${(this.core as any).teamId}/task`, {
            params
          });
        });

        const tasks = response.data.tasks;
        const totalCount = tasks.length;
        const hasMore = totalCount === 100;
        const nextPage = (filters.page || 0) + 1;

        (this.core as any).logOperation('getWorkspaceTasks', {
          method: 'Direct team endpoint SUCCESS',
          totalTasks: totalCount
        });

        // Continue with existing logic...
        const TOKEN_LIMIT = 50000;
        
        // Estimate tokens for the full response
        let tokensExceedLimit = false;
        
        if (filters.detail_level !== 'summary' && tasks.length > 0) {
          // We only need to check token count if detailed was requested
          // For summary requests, we always return summary format
          
          // First check with a sample task - if one task exceeds the limit, we definitely need summary
          const sampleTask = tasks[0];
          
          // Check if all tasks would exceed the token limit
          const estimatedTokensPerTask = (this.core as any).estimateTaskTokens(sampleTask);
          const estimatedTotalTokens = estimatedTokensPerTask * tasks.length;
          
          // Add 10% overhead for the response wrapper
          tokensExceedLimit = estimatedTotalTokens * 1.1 > TOKEN_LIMIT;
          
          // Double-check with more precise estimation if we're close to the limit
          if (!tokensExceedLimit && estimatedTotalTokens * 1.1 > TOKEN_LIMIT * 0.8) {
            // More precise check - build a representative sample and extrapolate
            tokensExceedLimit = wouldExceedTokenLimit(
              { tasks, total_count: totalCount, has_more: hasMore, next_page: nextPage },
              TOKEN_LIMIT
            );
          }
        }

        // Determine if we should return summary or detailed based on request and token limit
        const shouldUseSummary = filters.detail_level === 'summary' || tokensExceedLimit;

        (this.core as any).logOperation('getWorkspaceTasks', {
          totalTasks: tasks.length,
          estimatedTokens: tasks.reduce((count, task) => count + (this.core as any).estimateTaskTokens(task), 0),
          usingDetailedFormat: !shouldUseSummary,
          requestedFormat: filters.detail_level || 'auto'
        });

        if (shouldUseSummary) {
          return {
            summaries: tasks.map(task => (this.core as any).formatTaskSummary(task)),
            total_count: totalCount,
            has_more: hasMore,
            next_page: nextPage
          };
        }

        return {
          tasks,
          total_count: totalCount,
          has_more: hasMore,
          next_page: nextPage
        };
             } catch (error) {
         (this.core as any).logOperation('getWorkspaceTasks', { 
           error: error.message, 
           status: error.response?.status,
           fallback: 'Attempting space-based list discovery'
         });

         // Strategy 2: Fallback for space_ids - get lists in spaces and search them directly
         if (filters.space_ids && filters.space_ids.length > 0) {
           try {
             const allTasks: ClickUpTask[] = [];
             
             for (const spaceId of filters.space_ids) {
               try {
                 // Get lists in this space
                 const spaceLists = await (this.core as any).workspaceService.getListsInSpace(spaceId);
                 
                 // Search each list directly (limit to avoid rate limits)
                 for (const list of spaceLists.slice(0, 20)) {
                   try {
                     // Convert to basic filters for direct list API
                     const basicFilters: any = {};
                     if (filters.include_closed !== undefined) basicFilters.include_closed = filters.include_closed;
                     if (filters.archived !== undefined) basicFilters.archived = filters.archived;
                     if (filters.statuses && filters.statuses.length > 0) basicFilters.statuses = filters.statuses;
                     if (filters.assignees && filters.assignees.length > 0) basicFilters.assignees = filters.assignees;

                     const listTasks = await (this.core as any).getTasks(list.id, basicFilters);
                     allTasks.push(...listTasks);
                   } catch (listError) {
                     // Continue with other lists if one fails
                     (this.core as any).logOperation('getWorkspaceTasks', {
                       listId: list.id,
                       warning: 'Failed to get tasks from list in space fallback'
                     });
                   }
                 }
               } catch (spaceError) {
                 (this.core as any).logOperation('getWorkspaceTasks', {
                   spaceId,
                   warning: 'Failed to get lists for space in fallback'
                 });
               }
             }

             if (allTasks.length > 0) {
               (this.core as any).logOperation('getWorkspaceTasks', {
                 method: 'Space-based fallback SUCCESS',
                 totalTasks: allTasks.length
               });

               return {
                                   summaries: allTasks.map(task => ({
                    id: task.id,
                    name: task.name,
                    status: task.status?.status || 'unknown',
                    list: {
                      id: task.list?.id || '',
                      name: task.list?.name || ''
                    },
                    due_date: task.due_date,
                    url: task.url,
                                         priority: task.priority?.orderindex ? parseInt(task.priority.orderindex, 10) : null,
                    tags: (task.tags || []).map(tag => ({
                      name: tag.name,
                      tag_bg: tag.tag_bg,
                      tag_fg: tag.tag_fg
                    }))
                  })),
                 total_count: allTasks.length,
                 has_more: false,
                 next_page: 0
               };
             }
           } catch (fallbackError) {
             (this.core as any).logOperation('getWorkspaceTasks', {
               error: 'Space-based fallback failed',
               fallbackError: fallbackError.message
             });
           }
         }

         // If all fallbacks failed, re-throw the original error
         throw (this.core as any).handleError(error, 'Failed to get workspace tasks with all strategies');
       }
    } catch (error) {
      (this.core as any).logOperation('getWorkspaceTasks', { error: error.message, status: error.response?.status });
      throw (this.core as any).handleError(error, 'Failed to get workspace tasks');
    }
  }

  /**
   * Get task summaries for lightweight retrieval
   * @param filters Task filters to apply
   * @returns WorkspaceTasksResponse with task summaries
   */
  async getTaskSummaries(filters: TaskFilters = {}): Promise<WorkspaceTasksResponse> {
    return this.getWorkspaceTasks({ ...filters, detail_level: 'summary' }) as Promise<WorkspaceTasksResponse>;
  }

  /**
   * Get all views for a given list and identify the default "List" view ID
   * @param listId The ID of the list to get views for
   * @returns The ID of the default list view, or null if not found
   */
  async getListViews(listId: string): Promise<string | null> {
    try {
      (this.core as any).logOperation('getListViews', { listId });

      const response = await (this.core as any).makeRequest(async () => {
        return await (this.core as any).client.get(`/list/${listId}/view`);
      });

      // First try to get the default list view from required_views.list
      if (response.data.required_views?.list?.id) {
        (this.core as any).logOperation('getListViews', {
          listId,
          foundDefaultView: response.data.required_views.list.id,
          source: 'required_views.list'
        });
        return response.data.required_views.list.id;
      }

      // Fallback: look for a view with type "list" in the views array
      const listView = response.data.views?.find(view =>
        view.type?.toLowerCase() === 'list' ||
        view.name?.toLowerCase().includes('list')
      );

      if (listView?.id) {
        (this.core as any).logOperation('getListViews', {
          listId,
          foundDefaultView: listView.id,
          source: 'views_array_fallback',
          viewName: listView.name
        });
        return listView.id;
      }

      // If no specific list view found, use the first available view
      if (response.data.views?.length > 0) {
        const firstView = response.data.views[0];
        (this.core as any).logOperation('getListViews', {
          listId,
          foundDefaultView: firstView.id,
          source: 'first_available_view',
          viewName: firstView.name,
          warning: 'No specific list view found, using first available view'
        });
        return firstView.id;
      }

      (this.core as any).logOperation('getListViews', {
        listId,
        error: 'No views found for list',
        responseData: response.data
      });
      return null;

    } catch (error) {
      (this.core as any).logOperation('getListViews', {
        listId,
        error: error.message,
        status: error.response?.status
      });
      throw (this.core as any).handleError(error, `Failed to get views for list ${listId}`);
    }
  }

  /**
   * Retrieve tasks from a specific view, applying supported filters
   * @param viewId The ID of the view to get tasks from
   * @param filters Task filters to apply (only supported filters will be used)
   * @returns Array of ClickUpTask objects from the view
   */
  async getTasksFromView(viewId: string, filters: ExtendedTaskFilters = {}): Promise<ClickUpTask[]> {
    try {
      (this.core as any).logOperation('getTasksFromView', { viewId, filters });

      // Build query parameters for supported filters
      const params: Record<string, any> = {};

      // Map supported filters to query parameters
      if (filters.subtasks !== undefined) params.subtasks = filters.subtasks;
      if (filters.include_closed !== undefined) params.include_closed = filters.include_closed;
      if (filters.archived !== undefined) params.archived = filters.archived;
      if (filters.page !== undefined) params.page = filters.page;
      if (filters.order_by) params.order_by = filters.order_by;
      if (filters.reverse !== undefined) params.reverse = filters.reverse;

      // Status filtering
      if (filters.statuses && filters.statuses.length > 0) {
        params.statuses = filters.statuses;
      }

      // Assignee filtering
      if (filters.assignees && filters.assignees.length > 0) {
        params.assignees = filters.assignees;
      }

      // Date filters
      if (filters.date_created_gt) params.date_created_gt = filters.date_created_gt;
      if (filters.date_created_lt) params.date_created_lt = filters.date_created_lt;
      if (filters.date_updated_gt) params.date_updated_gt = filters.date_updated_gt;
      if (filters.date_updated_lt) params.date_updated_lt = filters.date_updated_lt;
      if (filters.due_date_gt) params.due_date_gt = filters.due_date_gt;
      if (filters.due_date_lt) params.due_date_lt = filters.due_date_lt;

      // Custom fields
      if (filters.custom_fields) {
        params.custom_fields = filters.custom_fields;
      }

      let allTasks: ClickUpTask[] = [];
      let currentPage = filters.page || 0;
      let hasMore = true;
      const maxPages = 50; // Safety limit to prevent infinite loops
      let pageCount = 0;

      while (hasMore && pageCount < maxPages) {
        const pageParams = { ...params, page: currentPage };

        const response = await (this.core as any).makeRequest(async () => {
          return await (this.core as any).client.get(`/view/${viewId}/task`, {
            params: pageParams
          });
        });

        const tasks = response.data.tasks || [];
        allTasks = allTasks.concat(tasks);

        // Check if there are more pages
        hasMore = response.data.has_more === true && tasks.length > 0;
        currentPage++;
        pageCount++;

        (this.core as any).logOperation('getTasksFromView', {
          viewId,
          page: currentPage - 1,
          tasksInPage: tasks.length,
          totalTasksSoFar: allTasks.length,
          hasMore
        });

        // If we're not paginating (original request had no page specified),
        // only get the first page
        if (filters.page === undefined && currentPage === 1) {
          break;
        }
      }

      if (pageCount >= maxPages) {
        (this.core as any).logOperation('getTasksFromView', {
          viewId,
          warning: `Reached maximum page limit (${maxPages}) while fetching tasks`,
          totalTasks: allTasks.length
        });
      }

      (this.core as any).logOperation('getTasksFromView', {
        viewId,
        totalTasks: allTasks.length,
        totalPages: pageCount
      });

      return allTasks;

    } catch (error) {
      (this.core as any).logOperation('getTasksFromView', {
        viewId,
        error: error.message,
        status: error.response?.status
      });
      throw (this.core as any).handleError(error, `Failed to get tasks from view ${viewId}`);
    }
  }

  /**
   * Get detailed task data
   * @param filters Task filters to apply
   * @returns DetailedTaskResponse with full task data
   */
  async getTaskDetails(filters: TaskFilters = {}): Promise<DetailedTaskResponse> {
    return this.getWorkspaceTasks({ ...filters, detail_level: 'detailed' }) as Promise<DetailedTaskResponse>;
  }

  /**
   * Unified method for finding tasks by ID or name with consistent handling of global lookup
   * 
   * This method provides a single entry point for all task lookup operations:
   * - Direct lookup by task ID (highest priority)
   * - Lookup by task name within a specific list
   * - Global lookup by task name across the entire workspace
   * 
   * @param options Lookup options with the following parameters:
   *   - taskId: Optional task ID for direct lookup
   *   - customTaskId: Optional custom task ID for direct lookup
   *   - taskName: Optional task name to search for
   *   - listId: Optional list ID to scope the search
   *   - listName: Optional list name to scope the search
   *   - allowMultipleMatches: Whether to return all matches instead of throwing an error
   *   - useSmartDisambiguation: Whether to automatically select the most recently updated task
   *   - includeFullDetails: Whether to include full task details (true) or just task summaries (false)
   *   - includeListContext: Whether to include list/folder/space context with results
   *   - requireExactMatch: Whether to only consider exact name matches (true) or allow fuzzy matches (false)
   * @returns Either a single task or an array of tasks depending on options
   * @throws Error if task cannot be found or if multiple matches are found when not allowed
   */
  async findTasks({
    taskId,
    customTaskId,
    taskName,
    listId,
    listName,
    allowMultipleMatches = false,
    useSmartDisambiguation = true,
    includeFullDetails = true,
    includeListContext = false,
    requireExactMatch = false
  }: {
    taskId?: string;
    customTaskId?: string;
    taskName?: string;
    listId?: string;
    listName?: string;
    allowMultipleMatches?: boolean;
    useSmartDisambiguation?: boolean;
    includeFullDetails?: boolean;
    includeListContext?: boolean;
    requireExactMatch?: boolean;
  }): Promise<ClickUpTask | ClickUpTask[] | null> {
    try {
      (this.core as any).logOperation('findTasks', {
        taskId,
        customTaskId,
        taskName,
        listId,
        listName,
        allowMultipleMatches,
        useSmartDisambiguation,
        requireExactMatch
      });

      // Check name-to-ID cache first if we have a task name
      if (taskName && !taskId && !customTaskId) {
        // Resolve list ID if we have a list name
        let resolvedListId = listId;
        if (listName && !listId) {
          const listInfo = await findListIDByName((this.core as any).workspaceService!, listName);
          if (listInfo) {
            resolvedListId = listInfo.id;
          }
        }

        // Try to get cached task ID
        const cachedTaskId = (this.core as any).getCachedTaskId(taskName, resolvedListId);
        if (cachedTaskId) {
          (this.core as any).logOperation('findTasks', {
            message: 'Using cached task ID for name lookup',
            taskName,
            cachedTaskId
          });
          taskId = cachedTaskId;
        }
      }
      
      // Case 1: Direct task ID lookup (highest priority)
      if (taskId) {
        // Check if it looks like a custom ID
        if (taskId.includes('-') && /^[A-Z]+\-\d+$/.test(taskId)) {
          (this.core as any).logOperation('findTasks', { detectedCustomId: taskId });

          try {
            // Try to get it as a custom ID first
            let resolvedListId: string | undefined;
            if (listId) {
              resolvedListId = listId;
            } else if (listName) {
              const listInfo = await findListIDByName((this.core as any).workspaceService!, listName);
              if (listInfo) {
                resolvedListId = listInfo.id;
              }
            }

            const foundTask = await this.core.getTaskByCustomId(taskId, resolvedListId);
            return foundTask;
          } catch (error) {
            // If it fails as a custom ID, try as a regular ID
            (this.core as any).logOperation('findTasks', {
              message: `Failed to find task with custom ID "${taskId}", falling back to regular ID`,
              error: error.message
            });
            return await this.core.getTask(taskId);
          }
        }

        // Regular task ID
        return await this.core.getTask(taskId);
      }

      // Case 2: Explicit custom task ID lookup
      if (customTaskId) {
        let resolvedListId: string | undefined;
        if (listId) {
          resolvedListId = listId;
        } else if (listName) {
          const listInfo = await findListIDByName((this.core as any).workspaceService!, listName);
          if (listInfo) {
            resolvedListId = listInfo.id;
          }
        }

        return await this.core.getTaskByCustomId(customTaskId, resolvedListId);
      }
      
      // Case 3: Task name lookup (requires either list context or global lookup)
      if (taskName) {
        // Case 3a: Task name + list context - search in specific list
        if (listId || listName) {
          let resolvedListId: string;
          if (listId) {
            resolvedListId = listId;
          } else {
            const listInfo = await findListIDByName((this.core as any).workspaceService!, listName!);
            if (!listInfo) {
              throw new Error(`List "${listName}" not found`);
            }
            resolvedListId = listInfo.id;
          }

          const foundTask = (this.core as any).findTaskInArray(await this.core.getTasks(resolvedListId), taskName, includeListContext);
          if (!foundTask) {
            throw new Error(`Task "${taskName}" not found in list`);
          }

          // Cache the task name to ID mapping with list context
          (this.core as any).cacheTaskNameToId(taskName, foundTask.id, resolvedListId);

          // If includeFullDetails is true and we need context not already in the task,
          // get full details, otherwise return what we already have
          if (includeFullDetails && (!foundTask.list || !foundTask.list.name || !foundTask.status)) {
            return await this.core.getTask(foundTask.id);
          }

          return foundTask;
        }

        // Case 3b: Task name without list context - global lookup across workspace
        // Get lightweight task summaries for efficient first-pass filtering
        (this.core as any).logOperation('findTasks', {
          message: `Starting global task search for "${taskName}"`,
          includeFullDetails,
          useSmartDisambiguation,
          requireExactMatch
        });

        // Use statuses parameter to get both open and closed tasks
        // Include additional filters to ensure we get as many tasks as possible
        const response = await this.getTaskSummaries({
          include_closed: true,
          include_archived_lists: true,
          include_closed_lists: true,
          subtasks: true
        });

        if (!(this.core as any).workspaceService) {
          throw new Error("Workspace service required for global task lookup");
        }

        // Create an index to efficiently look up list context information
        const hierarchy = await (this.core as any).workspaceService.getWorkspaceHierarchy();
        const listContextMap = new Map<string, { 
          listId: string, 
          listName: string, 
          spaceId: string, 
          spaceName: string, 
          folderId?: string, 
          folderName?: string 
        }>();
        
        // Function to recursively build list context map
        function buildListContextMap(nodes: any[], spaceId?: string, spaceName?: string, folderId?: string, folderName?: string) {
          for (const node of nodes) {
            if (node.type === 'space') {
              // Process space children
              if (node.children) {
                buildListContextMap(node.children, node.id, node.name);
              }
            } else if (node.type === 'folder') {
              // Process folder children
              if (node.children) {
                buildListContextMap(node.children, spaceId, spaceName, node.id, node.name);
              }
            } else if (node.type === 'list') {
              // Add list context to map
              listContextMap.set(node.id, {
                listId: node.id,
                listName: node.name,
                spaceId: spaceId!,
                spaceName: spaceName!,
                folderId,
                folderName
              });
            }
          }
        }
        
        // Build the context map
        buildListContextMap(hierarchy.root.children);
        
        // Find tasks that match the provided name with scored match results
        const initialMatches: { 
          id: string, 
          task: any, 
          listContext: any,
          matchScore: number,
          matchReason: string
        }[] = [];
        
        // Process task summaries to find initial matches
        let taskCount = 0;
        let matchesFound = 0;
        
        // Add additional logging to debug task matching
        (this.core as any).logOperation('findTasks', {
          total_tasks_in_response: response.summaries.length,
          search_term: taskName,
          requireExactMatch
        });

        for (const taskSummary of response.summaries) {
          taskCount++;

          // Use isNameMatch for consistent matching behavior with scoring
          const matchResult = isNameMatch(taskSummary.name, taskName);
          const isMatch = matchResult.isMatch;

          // For debugging, log every 20th task or any task with a similar name
          if (taskCount % 20 === 0 || taskSummary.name.toLowerCase().includes(taskName.toLowerCase()) ||
              taskName.toLowerCase().includes(taskSummary.name.toLowerCase())) {
            (this.core as any).logOperation('findTasks:matching', {
              task_name: taskSummary.name,
              search_term: taskName,
              list_name: taskSummary.list?.name || 'Unknown list',
              is_match: isMatch,
              match_score: matchResult.score,
              match_reason: matchResult.reason || 'no-match'
            });
          }
          
          if (isMatch) {
            matchesFound++;
            // Get list context information
            const listContext = listContextMap.get(taskSummary.list.id);
            
            if (listContext) {
              // Store task summary and context with match score
              initialMatches.push({
                id: taskSummary.id,
                task: taskSummary,
                listContext,
                matchScore: matchResult.score,
                matchReason: matchResult.reason || 'unknown'
              });
            }
          }
        }
        
        (this.core as any).logOperation('findTasks', {
          globalSearch: true,
          searchTerm: taskName,
          tasksSearched: taskCount,
          matchesFound: matchesFound,
          validMatchesWithContext: initialMatches.length
        });
        
        // Handle the no matches case
        if (initialMatches.length === 0) {
          throw new Error(`Task "${taskName}" not found in any list across your workspace. Please check the task name and try again.`);
        }
        
        // Sort matches by match score first (higher is better), then by update time
        initialMatches.sort((a, b) => {
          // First sort by match score (highest first)
          if (b.matchScore !== a.matchScore) {
            return b.matchScore - a.matchScore;
          }
          
          // Try to get the date_updated from the task
          const aDate = a.task.date_updated ? parseInt(a.task.date_updated, 10) : 0;
          const bDate = b.task.date_updated ? parseInt(b.task.date_updated, 10) : 0;
          
          // For equal scores, sort by most recently updated
          return bDate - aDate;
        });
        
        // Handle the single match case - we can return early if we don't need full details
        if (initialMatches.length === 1 && !useSmartDisambiguation && !includeFullDetails) {
          const match = initialMatches[0];
          
          if (includeListContext) {
            return {
              ...match.task,
              list: {
                id: match.listContext.listId,
                name: match.listContext.listName
              },
              folder: match.listContext.folderId ? {
                id: match.listContext.folderId,
                name: match.listContext.folderName
              } : undefined,
              space: {
                id: match.listContext.spaceId,
                name: match.listContext.spaceName
              }
            };
          }
          
          return match.task;
        }
        
        // Handle the exact match case - if there's an exact or very good match, prefer it over others
        // This is our key improvement to prefer exact matches over update time
        const bestMatchScore = initialMatches[0].matchScore;
        if (bestMatchScore >= 80) { // 80+ is an exact match or case-insensitive exact match
          // If there's a single best match with score 80+, use it directly
          const exactMatches = initialMatches.filter(m => m.matchScore >= 80);
          
          if (exactMatches.length === 1 && !allowMultipleMatches) {
            (this.core as any).logOperation('findTasks', {
              message: `Found single exact match with score ${exactMatches[0].matchScore}, prioritizing over other matches`,
              matchReason: exactMatches[0].matchReason
            });

            // If we don't need details, return early
            if (!includeFullDetails) {
              const match = exactMatches[0];
              if (includeListContext) {
                return {
                  ...match.task,
                  list: {
                    id: match.listContext.listId,
                    name: match.listContext.listName
                  },
                  folder: match.listContext.folderId ? {
                    id: match.listContext.folderId,
                    name: match.listContext.folderName
                  } : undefined,
                  space: {
                    id: match.listContext.spaceId,
                    name: match.listContext.spaceName
                  }
                };
              }
              return match.task;
            }

            // Otherwise, get the full details
            const fullTask = await this.core.getTask(exactMatches[0].id);
            
            if (includeListContext) {
              const match = exactMatches[0];
              // Enhance task with context information
              (fullTask as any).list = {
                ...fullTask.list,
                name: match.listContext.listName
              };
              
              if (match.listContext.folderId) {
                (fullTask as any).folder = {
                  id: match.listContext.folderId,
                  name: match.listContext.folderName
                };
              }
              
              (fullTask as any).space = {
                id: match.listContext.spaceId,
                name: match.listContext.spaceName
              };
            }
            
            return fullTask;
          }
        }
        
        // For multiple matches or when we need details, fetch full task info
        const fullMatches: ClickUpTask[] = [];
        const matchScoreMap = new Map<string, number>(); // To preserve match scores
        
        try {
          // Process in sequence for better reliability
          for (const match of initialMatches) {
            const fullTask = await this.core.getTask(match.id);
            matchScoreMap.set(fullTask.id, match.matchScore);
            
            if (includeListContext) {
              // Enhance task with context information
              (fullTask as any).list = {
                ...fullTask.list,
                name: match.listContext.listName
              };
              
              if (match.listContext.folderId) {
                (fullTask as any).folder = {
                  id: match.listContext.folderId,
                  name: match.listContext.folderName
                };
              }
              
              (fullTask as any).space = {
                id: match.listContext.spaceId,
                name: match.listContext.spaceName
              };
            }
            
            fullMatches.push(fullTask);
          }
          
          // Sort matches - first by match score, then by update time
          if (fullMatches.length > 1) {
            fullMatches.sort((a, b) => {
              // First sort by match score (highest first)
              const aScore = matchScoreMap.get(a.id) || 0;
              const bScore = matchScoreMap.get(b.id) || 0;
              
              if (aScore !== bScore) {
                return bScore - aScore;
              }
              
              // For equal scores, sort by update time
              const aDate = parseInt(a.date_updated || '0', 10);
              const bDate = parseInt(b.date_updated || '0', 10);
              return bDate - aDate; // Most recent first
            });
          }
        } catch (error) {
          (this.core as any).logOperation('findTasks', {
            error: error.message,
            message: "Failed to get detailed task information"
          });
          
          // If detailed fetch fails, use the summaries with context info
          // This fallback ensures we still return something useful
          if (allowMultipleMatches) {
            return initialMatches.map(match => ({
              ...match.task,
              list: {
                id: match.listContext.listId,
                name: match.listContext.listName
              },
              folder: match.listContext.folderId ? {
                id: match.listContext.folderId,
                name: match.listContext.folderName
              } : undefined,
              space: {
                id: match.listContext.spaceId,
                name: match.listContext.spaceName
              }
            }));
          } else {
            // For single result, return the first match (best match score)
            const match = initialMatches[0];
            return {
              ...match.task,
              list: {
                id: match.listContext.listId,
                name: match.listContext.listName
              },
              folder: match.listContext.folderId ? {
                id: match.listContext.folderId,
                name: match.listContext.folderName
              } : undefined,
              space: {
                id: match.listContext.spaceId,
                name: match.listContext.spaceName
              }
            };
          }
        }
        
        // After finding the task in global search, cache the mapping
        if (initialMatches.length === 1 || useSmartDisambiguation) {
          const bestMatch = fullMatches[0];
          (this.core as any).cacheTaskNameToId(taskName, bestMatch.id, bestMatch.list?.id);
          return bestMatch;
        }
        
        // Return results based on options
        if (fullMatches.length === 1 || useSmartDisambiguation) {
          return fullMatches[0]; // Return best match (sorted by score then update time)
        } else if (allowMultipleMatches) {
          return fullMatches; // Return all matches
        } else {
          // Format error message for multiple matches
          const matchesInfo = fullMatches.map(task => {
            const listName = task.list?.name || "Unknown list";
            const folderName = (task as any).folder?.name;
            const spaceName = (task as any).space?.name || "Unknown space";
            
            const updateTime = task.date_updated 
              ? new Date(parseInt(task.date_updated, 10)).toLocaleString()
              : "Unknown date";
              
            const matchScore = matchScoreMap.get(task.id) || 0;
            const matchQuality = 
              matchScore >= 100 ? "Exact match" :
              matchScore >= 80 ? "Case-insensitive exact match" :
              matchScore >= 70 ? "Text match ignoring emojis" :
              matchScore >= 50 ? "Contains search term" :
              "Partial match";
              
            const location = `list "${listName}"${folderName ? ` (folder: "${folderName}")` : ''} (space: "${spaceName}")`;
            return `- "${task.name}" in ${location} - Updated ${updateTime} - Match quality: ${matchQuality} (${matchScore}/100)`;
          }).join('\n');
          
          throw new Error(`Multiple tasks found with name "${taskName}":\n${matchesInfo}\n\nPlease provide list context to disambiguate, use the exact task name with requireExactMatch=true, or set allowMultipleMatches to true.`);
        }
      }
      
      // No valid lookup parameters provided
      throw new Error("At least one of taskId, customTaskId, or taskName must be provided");
    } catch (error) {
      if (error.message?.includes('Task "') && error.message?.includes('not found')) {
        throw error;
      }
      
      if (error.message?.includes('Multiple tasks found')) {
        throw error;
      }
      
      // Unexpected errors
      throw (this.core as any).handleError(error, `Error finding task: ${error.message}`);
    }
  }

  /**
   * Update a task by name within a specific list
   * @param listId The ID of the list containing the task
   * @param taskName The name of the task to update
   * @param updateData The data to update the task with
   * @returns The updated task
   */
  async updateTaskByName(listId: string, taskName: string, updateData: UpdateTaskData): Promise<ClickUpTask> {
    (this.core as any).logOperation('updateTaskByName', { listId, taskName, ...updateData });

    try {
      const task = await this.findTaskByName(listId, taskName);
      if (!task) {
        throw new Error(`Task "${taskName}" not found in list ${listId}`);
      }

      return await this.core.updateTask(task.id, updateData);
    } catch (error) {
      throw (this.core as any).handleError(error, `Failed to update task by name: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Global task search by name across all lists
   * This is a specialized method that uses getWorkspaceTasks to search all lists at once
   * which is more efficient than searching list by list
   * 
   * @param taskName The name to search for
   * @returns The best matching task or null if no match found
   */
  async findTaskByNameGlobally(taskName: string): Promise<ClickUpTask | null> {
    (this.core as any).logOperation('findTaskByNameGlobally', { taskName });
    
    // Use a static cache for task data to avoid redundant API calls
    // This dramatically reduces API usage across multiple task lookups
    if (!this.constructor.hasOwnProperty('_taskCache')) {
      Object.defineProperty(this.constructor, '_taskCache', {
        value: {
          tasks: [],
          lastFetch: 0,
          cacheTTL: 60000, // 1 minute cache TTL
        },
        writable: true
      });
    }
    
    const cache = (this.constructor as any)._taskCache;
    const now = Date.now();
    
    try {
      // Use cached tasks if available and not expired
      let tasks: ClickUpTask[] = [];
      if (cache.tasks.length > 0 && (now - cache.lastFetch) < cache.cacheTTL) {
        (this.core as any).logOperation('findTaskByNameGlobally', {
          usedCache: true,
          cacheAge: now - cache.lastFetch,
          taskCount: cache.tasks.length
        });
        tasks = cache.tasks;
      } else {
        // Get tasks using a single efficient workspace-wide API call
        const response = await this.getWorkspaceTasks({
          include_closed: true,
          detail_level: 'detailed'
        });

        tasks = 'tasks' in response ? response.tasks : [];

        // Update cache
        cache.tasks = tasks;
        cache.lastFetch = now;

        (this.core as any).logOperation('findTaskByNameGlobally', {
          usedCache: false,
          fetchedTaskCount: tasks.length
        });
      }

      // Map tasks to include match scores and updated time for sorting
      const taskMatches = tasks.map(task => {
        const matchResult = isNameMatch(task.name, taskName);
        return {
          task,
          matchResult,
          updatedAt: task.date_updated ? parseInt(task.date_updated, 10) : 0
        };
      }).filter(result => result.matchResult.isMatch);

      (this.core as any).logOperation('findTaskByNameGlobally', {
        taskCount: tasks.length,
        matchCount: taskMatches.length,
        taskName
      });
      
      if (taskMatches.length === 0) {
        return null;
      }
      
      // First try exact matches
      const exactMatches = taskMatches
        .filter(result => result.matchResult.exactMatch)
        .sort((a, b) => {
          // For exact matches with the same score, sort by most recently updated
          if (b.matchResult.score === a.matchResult.score) {
            return b.updatedAt - a.updatedAt;
          }
          return b.matchResult.score - a.matchResult.score;
        });
      
      // Get the best matches based on whether we have exact matches or need to fall back to fuzzy matches
      const bestMatches = exactMatches.length > 0 ? exactMatches : taskMatches.sort((a, b) => {
        // First sort by match score (highest first)
        if (b.matchResult.score !== a.matchResult.score) {
          return b.matchResult.score - a.matchResult.score;
        }
        // Then sort by most recently updated
        return b.updatedAt - a.updatedAt;
      });
      
      // Log the top matches for debugging
      const topMatches = bestMatches.slice(0, 3).map(match => ({
        taskName: match.task.name,
        score: match.matchResult.score,
        reason: match.matchResult.reason,
        updatedAt: match.updatedAt,
        list: match.task.list?.name || 'Unknown list'
      }));
      
      (this.core as any).logOperation('findTaskByNameGlobally', { topMatches });

      // Return the best match
      return bestMatches[0].task;
    } catch (error) {
      (this.core as any).logOperation('findTaskByNameGlobally', { error: error.message });

      // If there's an error (like rate limit), try to use cached data even if expired
      if (cache.tasks.length > 0) {
        (this.core as any).logOperation('findTaskByNameGlobally', {
          message: 'Using expired cache due to API error',
          cacheAge: now - cache.lastFetch
        });
        
        // Perform the same matching logic with cached data
        const taskMatches = cache.tasks
          .map(task => {
            const matchResult = isNameMatch(task.name, taskName);
            return {
              task,
              matchResult,
              updatedAt: task.date_updated ? parseInt(task.date_updated, 10) : 0
            };
          })
          .filter(result => result.matchResult.isMatch)
          .sort((a, b) => {
            if (b.matchResult.score !== a.matchResult.score) {
              return b.matchResult.score - a.matchResult.score;
            }
            return b.updatedAt - a.updatedAt;
          });
          
        if (taskMatches.length > 0) {
          return taskMatches[0].task;
        }
      }
      
      return null;
    }
  }

  /**
   * Direct Team API approach (Gemini recommendation)
   * Uses pure /team/{teamId}/task?list_ids[]=LIST_ID endpoint to get ALL tasks including multi-list
   * This bypasses Views API and directly queries ClickUp's team endpoint
   * @param listIds Array of list IDs to search for tasks
   * @param filters Additional filters to apply
   * @returns Array of ClickUpTask objects from team endpoint
   */
  async getTeamTasksDirectly(listIds: string[], filters: ExtendedTaskFilters = {}): Promise<ClickUpTask[]> {
    try {
      (this.core as any).logOperation('getTeamTasksDirectly', { 
        listIds, 
        filters,
        method: 'Pure Team API - Gemini Recommendation',
        diagnostics: {
          teamId: (this.core as any).teamId,
          listIdsCount: listIds.length,
          isSingleList: listIds.length === 1,
          isMultiList: listIds.length > 1,
          endpoint: `/team/${(this.core as any).teamId}/task`,
          listIdsParam: `list_ids[]=${listIds.join('&list_ids[]=')}`
        }
      });

      // DIAGNOSTIC: Try different strategies for multi-list vs single-list
      if (listIds.length > 1) {
        (this.core as any).logOperation('getTeamTasksDirectly', {
          listIds,
          approach: 'MULTI-LIST STRATEGY',
          strategy: 'Single request with multiple list_ids[] parameters',
          concern: 'This might be the root cause of 0 results',
          alternativeStrategies: [
            'Parallel requests per list_id',
            'Different parameter format',
            'Different ClickUp API endpoint'
          ]
        });
      } else {
        (this.core as any).logOperation('getTeamTasksDirectly', {
          listIds,
          approach: 'SINGLE-LIST STRATEGY',
          strategy: 'Single request with single list_ids[] parameter',
          note: 'This approach works reliably'
        });
      }

      // Build filters for team endpoint
      const teamFilters: ExtendedTaskFilters = {
        ...filters,
        list_ids: listIds // This is the key parameter according to Gemini
      };

      // Use direct team endpoint call
      const params = (this.core as any).buildTaskFilterParams(teamFilters);
      
      (this.core as any).logOperation('getTeamTasksDirectly', {
        listIds,
        parametersBuilt: true,
        paramsObject: Object.fromEntries(params.entries()),
        aboutToMakeRequest: true,
        criticalAnalysis: {
          listIdsInParams: params.getAll('list_ids[]'),
          listIdsCount: params.getAll('list_ids[]').length,
          expectedListIds: listIds,
          parameterFormatCorrect: JSON.stringify(params.getAll('list_ids[]')) === JSON.stringify(listIds)
        }
      });

      const response = await (this.core as any).makeRequest(async () => {
        return await (this.core as any).client.get(`/team/${(this.core as any).teamId}/task`, {
          params
        });
      });

      const tasks = response.data.tasks || [];

      (this.core as any).logOperation('getTeamTasksDirectly', {
        listIds,
        responseReceived: true,
        responseStatus: response.status,
        responseTasksCount: tasks.length,
        responseDataKeys: Object.keys(response.data || {}),
        apiLimitInfo: {
          totalTasks: response.data.total_count || 'N/A',
          hasMore: response.data.has_more || false
        },
        multiListAnalysis: listIds.length > 1 ? {
          expectedBehavior: 'Should return tasks from ALL specified lists',
          actualResult: tasks.length > 0 ? 'SUCCESS - tasks found' : 'FAILURE - no tasks returned',
          possibleCauses: tasks.length === 0 ? [
            'ClickUp API does not support multiple list_ids[] in single request',
            'Parameter format incorrect for multi-list',
            'Team permissions insufficient for cross-list queries',
            'API limitation requiring separate requests per list'
          ] : []
        } : {
          singleListNote: 'Single list query - working as expected'
        }
      });

      // Add discovery source marker for tracking
      const tasksWithSource = tasks.map(task => ({
        ...task,
        _discovery_source: 'direct_team_api'
      }));

      (this.core as any).logOperation('getTeamTasksDirectly', {
        listIds,
        criticalAnalysis: 'BEFORE PARALLEL STRATEGY CHECK',
        conditions: {
          isMultiList: listIds.length > 1,
          listIdsCount: listIds.length,
          tasksFoundCount: tasksWithSource.length,
          tasksEqualZero: tasksWithSource.length === 0,
          shouldActivateParallel: listIds.length > 1 && tasksWithSource.length === 0
        },
        decision: listIds.length > 1 && tasksWithSource.length === 0 ? 
          'PARALLEL STRATEGY SHOULD ACTIVATE' : 
          'PARALLEL STRATEGY WILL NOT ACTIVATE',
        reason: listIds.length <= 1 ? 'Single list detected' : 
                tasksWithSource.length > 0 ? 'Tasks found in multi-list request' : 
                'Unknown reason'
      });

      // EXPERIMENTAL: If multi-list request returned 0 tasks, try parallel strategy
      if (listIds.length > 1 && tasksWithSource.length === 0) {
        (this.core as any).logOperation('getTeamTasksDirectly', {
          listIds,
          experimentalApproach: 'PARALLEL STRATEGY',
          reason: 'Multi-list request returned 0 tasks - trying parallel requests per list_id',
          strategy: 'Make separate Direct Team API calls for each list_id and combine results',
          activationConditions: 'Multi-list AND zero tasks'
        });

        try {
          const parallelTasks: ClickUpTask[] = [];
          const parallelPromises = listIds.map(async (singleListId) => {
            try {
              (this.core as any).logOperation('getTeamTasksDirectly', {
                parallelRequest: true,
                singleListId,
                approach: 'Individual list request within parallel strategy'
              });

              const singleListFilters: ExtendedTaskFilters = {
                ...filters,
                list_ids: [singleListId] // Single list in array
              };

              const singleParams = (this.core as any).buildTaskFilterParams(singleListFilters);
              const singleResponse = await (this.core as any).makeRequest(async () => {
                return await (this.core as any).client.get(`/team/${(this.core as any).teamId}/task`, {
                  params: singleParams
                });
              });

              const singleTasks = (singleResponse.data.tasks || []).map(task => ({
                ...task,
                _discovery_source: 'direct_team_api_parallel'
              }));

              (this.core as any).logOperation('getTeamTasksDirectly', {
                parallelRequest: true,
                singleListId,
                tasksFound: singleTasks.length,
                result: singleTasks.length > 0 ? 'SUCCESS' : 'No tasks in this list'
              });

              return singleTasks;
            } catch (error) {
              (this.core as any).logOperation('getTeamTasksDirectly', {
                parallelRequest: true,
                singleListId,
                error: `Parallel request failed: ${error.message}`
              });
              return [];
            }
          });

          const parallelResults = await Promise.all(parallelPromises);
          
          // Combine and deduplicate results
          const combinedTasks = parallelResults.flat();
          const uniqueTaskIds = new Set<string>();
          const uniqueTasks = combinedTasks.filter(task => {
            if (uniqueTaskIds.has(task.id)) {
              return false;
            }
            uniqueTaskIds.add(task.id);
            return true;
          });

          (this.core as any).logOperation('getTeamTasksDirectly', {
            listIds,
            parallelStrategy: 'COMPLETED',
            individualResults: parallelResults.map((tasks, index) => ({
              listId: listIds[index],
              tasksFound: tasks.length
            })),
            combinedTasksCount: combinedTasks.length,
            uniqueTasksCount: uniqueTasks.length,
            duplicatesRemoved: combinedTasks.length - uniqueTasks.length,
            finalResult: uniqueTasks.length > 0 ? 'PARALLEL STRATEGY SUCCESS' : 'PARALLEL STRATEGY ALSO RETURNED 0 TASKS'
          });

          if (uniqueTasks.length > 0) {
            (this.core as any).logOperation('getTeamTasksDirectly', {
              listIds,
              method: 'Direct Team API SUCCESS (Parallel Strategy)',
              totalTasksFound: uniqueTasks.length,
              note: 'Multi-list single request failed, but parallel requests succeeded!'
            });
            return uniqueTasks;
          }

        } catch (parallelError) {
          (this.core as any).logOperation('getTeamTasksDirectly', {
            listIds,
            parallelStrategy: 'FAILED',
            error: `Parallel strategy failed: ${parallelError.message}`,
            fallback: 'Returning original empty result'
          });
        }
      }

      // CRITICAL FIX v0.9.9: INDEPENDENT Alternative Parallel Strategy for ALL multi-list requests
      if (listIds.length > 1) {
        (this.core as any).logOperation('getTeamTasksDirectly', {
          listIds,
          v099critical: 'INDEPENDENT ALTERNATIVE PARALLEL STRATEGY',
          primaryResults: tasksWithSource.length,
          bugFixed: 'v0.9.8 bug - alternative strategy was nested inside first strategy',
          reasoning: 'v0.9.9 - Alternative strategy now runs independently for ALL multi-list requests',
          willTryParallel: true
        });

        try {
          (this.core as any).logOperation('getTeamTasksDirectly', {
            v099debug: 'INDEPENDENT PARALLEL REQUESTS STARTING',
            listsToQuery: listIds,
            requestCount: listIds.length,
            note: 'This should now ALWAYS execute for multi-list requests'
          });

          const alternativePromises = listIds.map(async (singleListId, index) => {
            try {
              (this.core as any).logOperation('getTeamTasksDirectly', {
                v099debug: `INDEPENDENT PARALLEL REQUEST ${index + 1}/${listIds.length}`,
                singleListId,
                attempting: `Single request to list ${singleListId}`
              });

              const singleListFilters: ExtendedTaskFilters = {
                ...filters,
                list_ids: [singleListId]
              };

              const singleParams = (this.core as any).buildTaskFilterParams(singleListFilters);
              
              (this.core as any).logOperation('getTeamTasksDirectly', {
                v099debug: `INDEPENDENT PARALLEL REQUEST PARAMS`,
                singleListId,
                teamId: (this.core as any).teamId,
                endpoint: `/team/${(this.core as any).teamId}/task`,
                params: singleParams
              });

              const singleResponse = await (this.core as any).makeRequest(async () => {
                return await (this.core as any).client.get(`/team/${(this.core as any).teamId}/task`, {
                  params: singleParams
                });
              });

              const singleTasks = (singleResponse.data.tasks || []).map(task => ({
                ...task,
                _discovery_source: 'direct_team_api_parallel_v099'
              }));

              (this.core as any).logOperation('getTeamTasksDirectly', {
                v099debug: `INDEPENDENT PARALLEL REQUEST RESULT`,
                singleListId,
                tasksFound: singleTasks.length,
                taskIds: singleTasks.map(t => t.id),
                responseData: {
                  totalTasks: singleResponse.data.tasks?.length || 0,
                  hasData: !!singleResponse.data.tasks
                }
              });

              return singleTasks;
            } catch (error) {
              (this.core as any).logOperation('getTeamTasksDirectly', {
                v099debug: `INDEPENDENT PARALLEL REQUEST ERROR`,
                singleListId,
                error: error.message,
                stack: error.stack
              });
              return [];
            }
          });

          const alternativeResults = await Promise.all(alternativePromises);
          
          (this.core as any).logOperation('getTeamTasksDirectly', {
            v099debug: 'INDEPENDENT PARALLEL REQUESTS COMPLETED',
            resultsPerList: alternativeResults.map((tasks, i) => ({
              listId: listIds[i],
              taskCount: tasks.length,
              taskIds: tasks.map(t => t.id)
            })),
            totalRawResults: alternativeResults.flat().length
          });

          const combinedAlternative = alternativeResults.flat();
          
          // Deduplicate
          const uniqueTaskIds = new Set<string>();
          const uniqueAlternative = combinedAlternative.filter(task => {
            if (uniqueTaskIds.has(task.id)) {
              return false;
            }
            uniqueTaskIds.add(task.id);
            return true;
          });

          (this.core as any).logOperation('getTeamTasksDirectly', {
            listIds,
            v099debug: 'INDEPENDENT PARALLEL STRATEGY ANALYSIS',
            primaryApproach: {
              tasksFound: tasksWithSource.length,
              method: 'Multi-list single request'
            },
            alternativeApproach: {
              tasksFoundRaw: combinedAlternative.length,
              tasksFoundUnique: uniqueAlternative.length,
              method: 'Independent parallel individual requests',
              duplicatesRemoved: combinedAlternative.length - uniqueAlternative.length
            },
            comparison: {
              parallelMoreThanPrimary: uniqueAlternative.length > tasksWithSource.length,
              parallelEqualPrimary: uniqueAlternative.length === tasksWithSource.length,
              primaryMoreThanParallel: tasksWithSource.length > uniqueAlternative.length
            },
            decision: uniqueAlternative.length > tasksWithSource.length ? 
              'USING INDEPENDENT PARALLEL (more tasks found)' : 
              uniqueAlternative.length > 0 && tasksWithSource.length === 0 ?
              'USING INDEPENDENT PARALLEL (primary returned zero but parallel found tasks)' :
              'USING PRIMARY (equal or more tasks)'
          });

          // v0.9.9 Enhanced logic: Use independent parallel if it finds ANY tasks when primary found zero
          if (uniqueAlternative.length > tasksWithSource.length || 
              (tasksWithSource.length === 0 && uniqueAlternative.length > 0)) {
            (this.core as any).logOperation('getTeamTasksDirectly', {
              listIds,
              v099success: 'INDEPENDENT PARALLEL STRATEGY ACTIVATED',
              method: 'Direct Team API SUCCESS (Independent Parallel Strategy)',
              totalTasksFound: uniqueAlternative.length,
              note: 'v0.9.9 - Independent parallel approach used!',
              bugFixed: 'Alternative strategy was nested inside first strategy in v0.9.8',
              reasonUsed: tasksWithSource.length === 0 ? 
                'Primary returned zero, independent parallel found tasks' :
                'Independent parallel found more tasks than primary',
              v101forceDebug: 'FORCE RETURN - Testing Independent Parallel Strategy activation',
              debugInfo: {
                primaryTasksCount: tasksWithSource.length,
                parallelTasksCount: uniqueAlternative.length,
                returningTasks: uniqueAlternative.length,
                discoverySource: 'direct_team_api_parallel_v099'
              }
            });
            
            // v1.0.1 FORCE DEBUG: Add additional tracking for discovery source visibility
            const trackedResults = uniqueAlternative.map(task => ({
              ...task,
              _v101_force_debug: true,
              _discovery_method_override: 'Independent Parallel Strategy v1.0.1'
            }));
            
            return trackedResults;
          }

          (this.core as any).logOperation('getTeamTasksDirectly', {
            v099debug: 'INDEPENDENT PARALLEL STRATEGY NOT USED',
            reason: 'Primary approach equal or better',
            primaryTasks: tasksWithSource.length,
            parallelTasks: uniqueAlternative.length
          });

        } catch (parallelError) {
          (this.core as any).logOperation('getTeamTasksDirectly', {
            listIds,
            v099error: 'INDEPENDENT PARALLEL STRATEGY FAILED',
            error: parallelError.message,
            stack: parallelError.stack,
            note: 'Independent parallel strategy crashed - using primary results'
          });
        }
      }

      (this.core as any).logOperation('getTeamTasksDirectly', {
        listIds,
        totalTasksFound: tasksWithSource.length,
        method: tasksWithSource.length > 0 ? 'Direct Team API SUCCESS' : 'Direct Team API returned ZERO tasks',
        endpoint: `/team/${(this.core as any).teamId}/task`,
        listIdsParam: `list_ids[]=${listIds.join('&list_ids[]=')}`
      });

      return tasksWithSource;

    } catch (error) {
      (this.core as any).logOperation('getTeamTasksDirectly', {
        listIds,
        error: error.message,
        method: 'Direct Team API Failed'
      });
      throw (this.core as any).handleError(error, `Failed to get team tasks directly for lists: ${listIds.join(', ')}`);
    }
  }

  /**
   * Enhanced multi-list task discovery using hybrid approach
   * Combines Views API, workspace search, and cross-reference detection
   * @param listIds Array of list IDs to search for associated tasks
   * @param filters Additional filters to apply
   * @returns Array of ClickUpTask objects from all sources
   */
  async getMultiListTasks(listIds: string[], filters: ExtendedTaskFilters = {}): Promise<ClickUpTask[]> {
    // v1.0.4 HOTFIX: Removed this.core.logOperation calls to fix "Cannot read properties of undefined" error
    
    try {
      // v1.0.2 CRITICAL FIX: Try getTeamTasksDirectly first for multi-list
      const primaryResults = await this.getTeamTasksDirectly(listIds, filters);
      
      // If primary method worked, use those results
      if (primaryResults.length > 0) {
        // Mark as v1.0.2 success
        const markedResults = primaryResults.map(task => ({
          ...task,
          _v102_success: 'PRIMARY_GETTEAMTASKSDIRECTLY_SUCCESS',
          _discovery_method_override: 'Direct Team API (Multi-List Primary v1.0.2)'
        }));

        return markedResults as ClickUpTask[];
      }

      // v1.0.2 Fallback: If primary method failed, use existing hybrid approach

      // v1.0.2 COMPLETE FALLBACK: Full hybrid approach with all phases
      const allFallbackTasks: ClickUpTask[] = [];
      const processedTaskIds = new Set<string>();

      // Phase 1: Views API (was getTasksFromViews)
      const viewsTasks = await this.getTasksFromViews(listIds, filters);
      this.addUniqueTasksToCollection(viewsTasks, allFallbackTasks, processedTaskIds);

      // Phase 2: Cross-reference search in workspace
      const crossRefTasks = await this.findTasksByLocationsCrossReference(listIds, filters);
      this.addUniqueTasksToCollection(crossRefTasks, allFallbackTasks, processedTaskIds);

      // Phase 3: Direct task relationship analysis
      const relationshipTasks = await this.findTasksByRelationships(listIds, filters);
      this.addUniqueTasksToCollection(relationshipTasks, allFallbackTasks, processedTaskIds);

      // Combine primary and complete fallback results
      const allTasks = primaryResults.concat(allFallbackTasks);

      return allTasks;

    } catch (error) {
      throw new Error(`Failed to get multi-list tasks: ${error.message}`);
    }
  }

  /**
   * Phase 1: Direct Team API approach (Gemini recommendation) with Views API fallback
   * Uses /team/{teamId}/task?list_ids[]=LIST_ID to get ALL tasks including multi-list
   */
  private async getTasksFromViews(listIds: string[], filters: ExtendedTaskFilters): Promise<ClickUpTask[]> {
    const allTasks: ClickUpTask[] = [];

    try {
      // PRIMARY: Direct Team API (Gemini recommendation)
      (this.core as any).logOperation('getTasksFromViews', {
        listIds,
        method: 'Direct Team API (Gemini recommendation)',
        phase: 'Phase 1 - Primary approach',
        teamId: (this.core as any).teamId,
        endpoint: `/team/${(this.core as any).teamId}/task?list_ids[]=${listIds.join('&list_ids[]=')}`
      });

      const teamTasks = await this.getTeamTasksDirectly(listIds, filters);
      
      (this.core as any).logOperation('getTasksFromViews', {
        listIds,
        method: 'Direct Team API Response Analysis',
        tasksFoundCount: teamTasks.length,
        hasDiscoverySourceMarker: teamTasks.length > 0 ? (teamTasks[0] as any)._discovery_source : 'N/A',
        taskDetails: teamTasks.length > 0 ? {
          firstTaskId: teamTasks[0].id,
          firstTaskName: teamTasks[0].name,
          firstTaskListId: teamTasks[0].list?.id
        } : 'No tasks returned'
      });

      if (teamTasks.length > 0) {
        (this.core as any).logOperation('getTasksFromViews', {
          listIds,
          method: 'Direct Team API SUCCESS - returning tasks with discovery source tracking',
          tasksFound: teamTasks.length,
          result: 'Found tasks with Direct Team API - multi-list tasks included!',
          discoverySourceCheck: teamTasks.every(task => (task as any)._discovery_source === 'direct_team_api')
        });
        return teamTasks;
      }

      (this.core as any).logOperation('getTasksFromViews', {
        listIds,
        warning: 'Direct Team API returned ZERO tasks - investigating why',
        possibleCauses: [
          'Lists exist but contain no tasks',
          'API permissions insufficient', 
          'List IDs invalid or inaccessible',
          'Team ID mismatch',
          'Filters too restrictive'
        ],
        fallback: 'Proceeding to Views API fallback'
      });

    } catch (error) {
      (this.core as any).logOperation('getTasksFromViews', {
        listIds,
        error: `Direct Team API FAILED with error: ${error.message}`,
        errorDetails: {
          status: error.response?.status,
          statusText: error.response?.statusText,
          url: error.config?.url
        },
        fallback: 'Trying Views API + Direct List API fallback'
      });
    }

    // FALLBACK: Original Views API + Direct List API approach
    (this.core as any).logOperation('getTasksFromViews', {
      listIds,
      phase: 'FALLBACK Phase - Views API + Direct List API',
      reason: 'Direct Team API returned 0 tasks or failed'
    });

    const fetchPromises = listIds.map(async (listId: string) => {
      try {
        // Try Views API first
        const viewId = await this.getListViews(listId);
        if (viewId) {
          const viewTasks = await this.getTasksFromView(viewId, filters);
          if (viewTasks.length > 0) {
            (this.core as any).logOperation('getTasksFromViews', {
              listId,
              method: 'Views API (fallback)',
              tasksFound: viewTasks.length,
              addingDiscoverySourceMarkers: true
            });
            
            // Add fallback discovery source markers
            return viewTasks.map(task => ({
              ...task,
              _discovery_source: 'views_api_fallback'
            }));
          }
        }

        // Final fallback: Direct List API
        (this.core as any).logOperation('getTasksFromViews', {
          listId,
          warning: 'Views API failed, trying Direct List API final fallback'
        });

        const directListTasks = await (this.core as any).getTasks(listId, filters);
        if (directListTasks.length > 0) {
          (this.core as any).logOperation('getTasksFromViews', {
            listId,
            method: 'Direct List API (final fallback)', 
            tasksFound: directListTasks.length,
            addingDiscoverySourceMarkers: true
          });
          
          // Add final fallback discovery source markers
          return directListTasks.map(task => ({
            ...task,
            _discovery_source: 'direct_list_api_fallback'
          }));
        }

        return [];
      } catch (error) {
        (this.core as any).logOperation('getTasksFromViews', {
          listId,
          error: `All fallback methods failed: ${error.message}`
        });
        return [];
      }
    });

    const taskArrays = await Promise.all(fetchPromises);
    for (const tasks of taskArrays) {
      allTasks.push(...tasks);
    }

    return allTasks;
  }

  /**
   * Phase 2: Cross-reference search using alternative strategies
   * Uses Direct List API in related spaces since Workspace API is unreliable
   */
  private async findTasksByLocationsCrossReference(listIds: string[], filters: ExtendedTaskFilters): Promise<ClickUpTask[]> {
    try {
      (this.core as any).logOperation('findTasksByLocationsCrossReference', { 
        listIds, 
        strategy: 'Direct List API - Alternative to Workspace API' 
      });

      const crossRefTasks: ClickUpTask[] = [];

      // Strategy 1: Search in commonly related lists within the same spaces
      try {
        // Get space IDs from target lists to search related lists
        const spaceListsMap = new Map<string, string[]>();
        
        for (const listId of listIds) {
          try {
            const list = await (this.core as any).listService.getList(listId);
            const spaceId = list.space?.id;
            if (spaceId) {
              if (!spaceListsMap.has(spaceId)) {
                spaceListsMap.set(spaceId, []);
              }
              spaceListsMap.get(spaceId)!.push(listId);
            }
          } catch (error) {
            (this.core as any).logOperation('findTasksByLocationsCrossReference', {
              listId,
              error: 'Failed to get list details for space mapping'
            });
          }
        }

        // Search in related lists within same spaces
        for (const [spaceId, spaceListIds] of spaceListsMap) {
          try {
            // Get other lists in the same space
            const spaceLists = await (this.core as any).workspaceService.getListsInSpace(spaceId);
            const relatedListIds = spaceLists
              .map(list => list.id)
              .filter(id => !spaceListIds.includes(id)) // Exclude target lists
              .slice(0, 10); // Limit to avoid rate limits

            // Search each related list for tasks that might reference our target lists
            for (const relatedListId of relatedListIds) {
              try {
                const basicFilters: any = {};
                if (filters.include_closed !== undefined) basicFilters.include_closed = filters.include_closed;
                if (filters.archived !== undefined) basicFilters.archived = filters.archived;
                if (filters.assignees && filters.assignees.length > 0) basicFilters.assignees = filters.assignees;

                const relatedTasks = await (this.core as any).getTasks(relatedListId, basicFilters);
                
                // Filter tasks that have target lists in their locations
                const matchingTasks = relatedTasks.filter(task => {
                  const locations = task.locations || [];
                  return locations.some(location => listIds.includes(location.id));
                });

                crossRefTasks.push(...matchingTasks);
                
                if (matchingTasks.length > 0) {
                  (this.core as any).logOperation('findTasksByLocationsCrossReference', {
                    relatedListId,
                    spaceId,
                    tasksWithMatchingLocations: matchingTasks.length
                  });
                }
              } catch (error) {
                // Continue searching other lists if one fails
                (this.core as any).logOperation('findTasksByLocationsCrossReference', {
                  relatedListId,
                  error: 'Failed to search related list'
                });
              }
            }
          } catch (error) {
            (this.core as any).logOperation('findTasksByLocationsCrossReference', {
              spaceId,
              error: 'Failed to get lists in space'
            });
          }
        }
      } catch (error) {
        (this.core as any).logOperation('findTasksByLocationsCrossReference', {
          error: 'Strategy 1 failed completely',
          message: error.message
        });
      }

      (this.core as any).logOperation('findTasksByLocationsCrossReference', {
        totalCrossRefTasks: crossRefTasks.length,
        strategy: 'Direct List API search in related spaces'
      });

      return crossRefTasks;

    } catch (error) {
      (this.core as any).logOperation('findTasksByLocationsCrossReference', {
        listIds,
        error: error.message
      });
      return [];
    }
  }

  /**
   * Phase 3: Direct task relationship analysis
   * Uses targeted search by assignees and recent activity to find related tasks
   */
  private async findTasksByRelationships(listIds: string[], filters: ExtendedTaskFilters): Promise<ClickUpTask[]> {
    try {
      (this.core as any).logOperation('findTasksByRelationships', { listIds });

      const relationshipTasks: ClickUpTask[] = [];

      // Strategy 1: Search by assignees who have tasks in target lists
      if (filters.assignees && filters.assignees.length > 0) {
        const assigneeTasks = await this.findTasksByAssigneeActivity(filters.assignees, listIds);
        relationshipTasks.push(...assigneeTasks);
      }

      // Strategy 2: Search by tags that appear in target lists
      if (filters.tags && filters.tags.length > 0) {
        const tagTasks = await this.findTasksByTagsAcrossLists(filters.tags, listIds);
        relationshipTasks.push(...tagTasks);
      }

      (this.core as any).logOperation('findTasksByRelationships', {
        relationshipTasksFound: relationshipTasks.length
      });

      return relationshipTasks;

    } catch (error) {
      (this.core as any).logOperation('findTasksByRelationships', {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Find tasks by assignee activity patterns
   */
  private async findTasksByAssigneeActivity(assignees: string[], targetListIds: string[]): Promise<ClickUpTask[]> {
    try {
      const assigneeTasks = await this.getWorkspaceTasks({
        assignees,
        date_updated_gt: Date.now() - (30 * 24 * 60 * 60 * 1000), // Last 30 days
        include_closed: true
      });

      const tasks = 'tasks' in assigneeTasks ? assigneeTasks.tasks : [];
      
      // Look for tasks that might be related to target lists
      return tasks.filter(task => {
        // Check if task has locations pointing to target lists
        if (task.locations && task.locations.length > 0) {
          return task.locations.some(location => targetListIds.includes(location.id));
        }
        
        // Additional heuristics could be added here
        return false;
      });

    } catch (error) {
      return [];
    }
  }

  /**
   * Find tasks by tags across lists
   */
  private async findTasksByTagsAcrossLists(tags: string[], targetListIds: string[]): Promise<ClickUpTask[]> {
    try {
      const tagTasks = await this.getWorkspaceTasks({
        tags,
        date_updated_gt: Date.now() - (60 * 24 * 60 * 60 * 1000), // Last 60 days
        include_closed: true
      });

      const tasks = 'tasks' in tagTasks ? tagTasks.tasks : [];
      
      return tasks.filter(task => {
        if (task.locations && task.locations.length > 0) {
          return task.locations.some(location => targetListIds.includes(location.id));
        }
        return false;
      });

    } catch (error) {
      return [];
    }
  }

  /**
   * Helper to add unique tasks to collection
   */
  private addUniqueTasksToCollection(newTasks: ClickUpTask[], collection: ClickUpTask[], processedIds: Set<string>) {
    for (const task of newTasks) {
      if (!processedIds.has(task.id)) {
        collection.push(task);
        processedIds.add(task.id);
      }
    }
  }
}

