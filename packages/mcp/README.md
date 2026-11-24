# oafactory-mcp

An MCP server for [OAFactory](https://github.com/khalaharvi/oafactory). Connect it to Claude or any other MCP client and write work orders in conversation: the assistant drafts the request, shows you in plain words what would happen, and saves it for the factory to run.

Built on version 2 of the MCP TypeScript SDK (`@modelcontextprotocol/server`), over stdio.

```bash
oafactory-mcp --cwd /path/to/your/repository
```

| Tool | What it does |
|---|---|
| `factory_overview` | Reads the project's rules, budget ceilings and risk levels |
| `draft_work_order` | Explains what a request would do. Changes nothing |
| `save_work_order` | Saves a work order, outside the repository |
| `list_work_orders` | Lists work orders and what happened to each |
| `get_run` | Explains the result of a work order in plain words |
| `explain_receipt` | Explains one receipt in plain words |
| `run_work_order` | Starts a saved work order. Only offered with `--allow-run` |

By default the server cannot start work: it saves the work order and a person runs it with `oafactory run`. Pass `--allow-run` to let the assistant start runs.

Setup and details: [Use it from Claude (MCP)](https://github.com/khalaharvi/oafactory/blob/main/docs/guides/mcp.mdx).
