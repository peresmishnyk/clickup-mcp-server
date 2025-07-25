/**
 * SPDX-FileCopyrightText: © 2025 Talib Kareem <taazkareem@icloud.com>
 * SPDX-License-Identifier: MIT
 *
 * ClickUp MCP Task Tools
 * 
 * This module re-exports all task-related tools and handlers.
 */

// Re-export from main module
export * from './main.js';

// Re-export single task operation tools
export { 
  createTaskTool,
  getTaskTool,
  getTasksTool,
  updateTaskTool,
  moveTaskTool,
  duplicateTaskTool,
  deleteTaskTool,
  getTaskCommentsTool,
  createTaskCommentTool,
  addTaskToListTool,
  removeTaskFromListTool
} from './single-operations.js';

// Re-export bulk task operation tools
export {
  createBulkTasksTool,
  updateBulkTasksTool,
  moveBulkTasksTool,
  deleteBulkTasksTool
} from './bulk-operations.js';

// Re-export workspace task operation tools
export {
  getWorkspaceTasksTool,
  getMultiListTasksTool
} from './workspace-operations.js';

// Re-export time tracking tools and handlers
export {
  getTaskTimeEntriesTool,
  startTimeTrackingTool,
  stopTimeTrackingTool,
  addTimeEntryTool,
  deleteTimeEntryTool,
  getCurrentTimeEntryTool,
  handleGetTaskTimeEntries,
  handleStartTimeTracking,
  handleStopTimeTracking,
  handleAddTimeEntry,
  handleDeleteTimeEntry,
  handleGetCurrentTimeEntry,
  timeTrackingTools,
  timeTrackingHandlers
} from './time-tracking.js';

// Re-export attachment tool
export {
  attachTaskFileTool,
  handleAttachTaskFile
} from './attachments.js';

// Re-export handlers
export {
  // Single task operation handlers
  createTaskHandler,
  getTaskHandler,
  getTasksHandler,
  updateTaskHandler,
  moveTaskHandler,
  duplicateTaskHandler,
  deleteTaskHandler,
  getTaskCommentsHandler,
  createTaskCommentHandler,
  handleAddTaskToList,
  handleRemoveTaskFromList,
  
  // Bulk task operation handlers
  createBulkTasksHandler,
  updateBulkTasksHandler,
  moveBulkTasksHandler,
  deleteBulkTasksHandler,
  
  // Team task operation handlers
  getWorkspaceTasksHandler,
  getMultiListTasksHandler
} from './handlers.js';

// Re-export utilities
export {
  formatTaskData,
  validateTaskIdentification,
  validateListIdentification,
  validateTaskUpdateData,
  validateBulkTasks,
  parseBulkOptions,
  resolveListIdWithValidation
} from './utilities.js';
