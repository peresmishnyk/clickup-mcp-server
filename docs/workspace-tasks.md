# Enhanced Multi-List Task Discovery (NEW)

## 🚀 `get_multi_list_tasks` - Advanced Multi-List Task Discovery

**NEW TOOL**: Specifically designed to solve ClickUp's "tasks in multiple lists" visibility problem using a comprehensive 3-phase hybrid approach.

### 🎯 Why This Tool Exists

The standard ClickUp API has a fundamental limitation: tasks added to multiple lists through the "Tasks in Multiple Lists" feature are often not returned by standard list queries. This tool uses advanced discovery techniques to find ALL tasks associated with specified lists.

### 🔍 Discovery Strategy (3-Phase Hybrid Approach)

1. **Views API Phase**: Uses ClickUp's Views API to get tasks visible in list views
2. **Cross-Reference Phase**: Searches workspace for tasks with target lists in their 'locations' field  
3. **Relationship Phase**: Finds related tasks through assignee patterns and tag associations

### 📝 Usage Examples

#### Basic Multi-List Discovery
```json
{
  "list_ids": ["901211234743", "901210885565"],
  "detail_level": "summary"
}
```

#### Enhanced Discovery with Filters
```json
{
  "list_ids": ["901211234743"],
  "assignees": ["42313666"],
  "statuses": ["in progress", "ready for development"],
  "tags": ["sprint", "urgent"],
  "date_updated_gt": 1672531200000,
  "enable_timing": true,
  "enable_statistics": true
}
```

### 📊 Response Format

#### Summary Response
```json
{
  "summaries": [
    {
      "id": "8699rtxt0",
      "name": "Task Name",
      "status": "in progress",
      "list": {
        "id": "901210885565",
        "name": "Meets and Events"
      },
      "locations": [
        {
          "id": "901211234743",
          "name": "Sprint 57 (7/21 - 8/3)"
        }
      ],
      "due_date": "1753408800000",
      "url": "https://app.clickup.com/t/8699rtxt0",
      "priority": "urgent",
      "tags": [{"name": "sprint", "tag_bg": "#ff0000"}],
      "assignees": [{"id": "42313666", "username": "dmitriy"}]
    }
  ],
  "total_count": 15,
  "_meta": {
    "discovery_method": "Enhanced Multi-List (Hybrid)",
    "phases_used": ["Views API", "Cross-Reference", "Relationships"],
    "timing": {
      "total_ms": 1250
    },
    "statistics": {
      "total_unique_tasks": 15,
      "lists_searched": 2
    }
  }
}
```

### 🎛️ Parameters

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| `list_ids` | array | Array of list IDs to search for associated tasks | ✅ Yes |
| `tags` | array | Filter by tag names (enhances relationship discovery) | No |
| `statuses` | array | Filter by status names | No |
| `assignees` | array | Filter by assignee IDs (enhances relationship discovery) | No |
| `date_updated_gt` | number | Filter for tasks updated after timestamp (recommended for performance) | No |
| `detail_level` | string | "summary" or "detailed" (default: detailed) | No |
| `enable_timing` | boolean | Include timing statistics in metadata (default: false) | No |
| `enable_statistics` | boolean | Include discovery statistics in metadata (default: true) | No |

### 🚀 Performance Features

- **Concurrent API calls** for optimal speed
- **Automatic deduplication** of results
- **Smart filtering** to minimize API load
- **Detailed timing and statistics** in response metadata
- **Token-aware response formatting** (auto-switch to summary if needed)

### 🎯 Use Cases

- **Sprint Planning**: Find all tasks moved from backlogs to sprints
- **Cross-Team Collaboration**: Discover shared tasks across teams
- **Project Management**: Tasks spanning multiple workflows
- **Debugging**: Troubleshoot missing task visibility issues
- **Reporting**: Complete task coverage across list boundaries

### ⚡ Performance Tips

1. **Use date filters** to limit search scope:
   ```json
   {"list_ids": ["123"], "date_updated_gt": 1672531200000}
   ```

2. **Include assignee/tag filters** for better relationship discovery:
   ```json
   {"list_ids": ["123"], "assignees": ["456"], "tags": ["project-x"]}
   ```

3. **Use summary format** for large datasets:
   ```json
   {"list_ids": ["123"], "detail_level": "summary"}
   ```

### 🔄 Migration from `get_workspace_tasks`

**OLD (limited coverage)**:
```json
{"list_ids": ["901211234743"]}
```

**NEW (comprehensive coverage)**:
```json
// Option 1: Use get_multi_list_tasks directly
{"list_ids": ["901211234743"]}

// Option 2: get_workspace_tasks now uses enhanced discovery automatically
{"list_ids": ["901211234743"]}
```

Both `get_workspace_tasks` and `get_multi_list_tasks` now use the same enhanced discovery engine when `list_ids` are provided!

---

# get_workspace_tasks (Enhanced)

The `get_workspace_tasks` tool provides a powerful way to retrieve tasks across the entire workspace with flexible filtering options, including tag-based filtering. This tool is especially useful for cross-list task organization and reporting.

## Key Features

- **Workspace-Wide Access**: Unlike `get_tasks` which only searches in one list, this tool searches across all spaces, folders, and lists.
- **Enhanced List Filtering**: When `list_ids` are provided, uses ClickUp's Views API for comprehensive task coverage, including tasks in multiple lists.
- **Multi-List Task Support**: Retrieves tasks that are *associated with* specified lists, not just created in them.
- **Two-Tier Filtering Strategy**:
  - **Server-side**: Supported filters applied at ClickUp API level for efficiency
  - **Client-side**: Additional filters (tags, folders, spaces) applied after data retrieval
- **Tag-Based Filtering**: Find tasks with specific tags anywhere in the workspace.
- **Multiple Filtering Dimensions**: Filter by lists, folders, spaces, statuses, assignees, and more.
- **Date Filtering**: Search by creation date, update date, or due date ranges.
- **Adaptive Response Format**: Automatic switching between summary and detailed formats based on response size.
- **Subtasks Support**: Include subtasks in results with proper filtering.
- **Pagination Support**: Handle large result sets efficiently with concurrent processing.

## Important Requirements

⚠️ **At least one filter parameter is REQUIRED**. You cannot retrieve all workspace tasks without any filters. Use parameters like `tags`, `list_ids`, `folder_ids`, `space_ids`, `statuses`, `assignees`, or date filters.

## Usage Examples

### Enhanced List Filtering (Multi-List Tasks)

**NEW**: When using `list_ids`, the tool now uses ClickUp's Views API to get comprehensive task coverage:

```json
{
  "list_ids": ["901407112060"],
  "detail_level": "summary"
}
```

This retrieves **all tasks associated with the list**, including:
- ✅ Tasks originally created in the list
- ✅ Tasks created elsewhere and added to the list
- ✅ Tasks appearing through ClickUp's "tasks in multiple lists" feature

### Basic Filtering Examples

### Tag Filtering

Find all tasks with the "bug" tag:

```json
{
  "tags": ["bug"]
}
```

Find tasks that have both "bug" and "high-priority" tags:

```json
{
  "tags": ["bug", "high-priority"]
}
```

### Combining Multiple Filters

Find high-priority bugs assigned to a specific user that are due this month:

```json
{
  "tags": ["bug", "high-priority"],
  "assignees": ["12345"],
  "due_date_gt": 1680300000000,
  "due_date_lt": 1682978400000
}
```

### Filtering by Space and List

Find all tasks in a specific space:

```json
{
  "space_ids": ["space123"]
}
```

Find tasks in multiple lists (uses enhanced Views API):

```json
{
  "list_ids": ["list123", "list456"],
  "detail_level": "detailed"
}
```

### Status and Archive Filtering

Find only open tasks:

```json
{
  "include_closed": false,
  "tags": ["active"]
}
```

Include archived tasks:

```json
{
  "archived": true,
  "space_ids": ["space123"]
}
```

### Response Format Control

Control the level of detail in responses:

```json
{
  "list_ids": ["901407112060"],
  "detail_level": "summary"
}
```

- **`summary`**: Lightweight response with essential task information
- **`detailed`**: Complete task information with all fields (default)

**Note**: Responses exceeding 50,000 tokens automatically switch to summary format.

### Subtasks Support

Include subtasks in results:

```json
{
  "list_ids": ["901407112060"],
  "subtasks": true,
  "tags": ["project-x"]
}
```

**Important**: Subtasks must still match your other filter criteria to appear in results.

### Pagination

Get the first page of tasks, sorted by creation date:

```json
{
  "tags": ["bug"],
  "page": 0,
  "order_by": "created",
  "reverse": true
}
```

Get the second page:

```json
{
  "tags": ["bug"],
  "page": 1,
  "order_by": "created",
  "reverse": true
}
```

## Performance Considerations

For large workspaces, it's recommended to:

1. Use specific filters to narrow down results
2. Use pagination to handle large result sets
3. Consider filtering by space or list when possible
4. Be mindful of rate limiting implications

## Related Tools

- `get_tasks`: Retrieves tasks from a specific list
- `get_task`: Gets a single task's details
- `get_space_tags`: Retrieves available tags in a space that can be used for filtering 