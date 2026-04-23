# tools.chat.js 无 tools 参数时回退到正常聊天逻辑

## Context

用户反馈：`tools 参数无效或为空` 错误在 `src/controllers/tools.chat.js:482-489` 处触发。但有时候请求确实没有工具，这时候不应该报错，而是直接走原先的正常聊天逻辑即可。

## Analysis

- **Affected files**:
  - `src/controllers/tools.chat.js` — 需要修改 `handleToolsChatCompletion`，当 `tools` 为空时回退到正常聊天逻辑
  - `src/routes/tools.chat.js` — 可能需要调整路由中间件以支持正常聊天的 `enable_thinking` / `enable_web_search`
- **New files**: 无
- **Dependencies**:
  - `src/controllers/chat.js` — 提供 `handleChatCompletion` 作为回退目标
- **Complexity**: simple
- **Risk areas**:
  - 需要确认 `tools.chat.js` 路由是否经过 `processRequestBody` 中间件（正常聊天路由有）
  - `handleChatCompletion` 依赖 `req.enable_thinking` 和 `req.enable_web_search`，这些由 `processRequestBody` 中间件注入

## Phases

### Phase 1: 修改 tools.chat.js 控制器，支持无 tools 时回退

- **Goal**: 当 `tools` 参数无效或为空时，调用正常的 `handleChatCompletion` 而非返回 400 错误
- **Files**: `src/controllers/tools.chat.js`
- **Steps**:
  - [ ] 引入 `handleChatCompletion` from `../controllers/chat.js`
  - [ ] 修改 `handleToolsChatCompletion` 中的 tools 校验逻辑：如果 `!tools || tools.length === 0`，直接 `return handleChatCompletion(req, res)`
- **Done when**:
  - 代码逻辑正确，无 tools 时直接转发到正常聊天处理
  - 文件无语法错误

### Phase 2: 调整 tools.chat.js 路由，注入必要中间件

- **Goal**: 确保 tools 聊天路由也经过 `processRequestBody` 中间件，使 `handleChatCompletion` 能正确读取 `req.enable_thinking` 等属性
- **Files**: `src/routes/tools.chat.js`
- **Steps**:
  - [ ] 引入 `processRequestBody` from `../middlewares/chat-middleware.js`
  - [ ] 在路由中添加 `processRequestBody` 中间件（在 `apiKeyVerify` 之后，`handleToolsChatCompletion` 之前）
- **Done when**:
  - 路由中间件顺序与正常聊天路由一致
  - 文件无语法错误

### Phase 3: 验证

- **Goal**: 确保修改后无编译/运行时错误
- **Steps**:
  - [ ] 运行 `node` 语法检查或启动服务确认无报错
  - [ ] 检查 IDE diagnostics
- **Done when**:
  - 服务能正常启动
  - 无 diagnostic 错误

## Risks & Mitigations

| Risk                                                           | Impact     | Mitigation                                                 |
| -------------------------------------------------------------- | ---------- | ---------------------------------------------------------- |
| `handleChatCompletion` 依赖 `req.enable_thinking` 等未定义属性 | 运行时错误 | 确保 `processRequestBody` 中间件在 tools 路由中也生效      |
| 循环依赖                                                       | 启动失败   | 检查 `tools.chat.js` 和 `chat.js` 之间是否形成循环 require |

## Completion Summary

**Status**: Completed
**Phases**: 3 / 3

### Results

- `src/controllers/tools.chat.js`：引入 `handleChatCompletion`，当 `tools` 为空时直接回退到正常聊天逻辑
- `src/routes/tools.chat.js`：添加 `processRequestBody` 中间件，确保回退时 `req.enable_thinking` 等属性可用

### Deviations

- 无偏差，按原计划执行

### Verification

- [x] Build passes（node require 无报错）
- [x] No diagnostic errors（仅 CommonJS hint，非错误）
- [x] Acceptance criteria met

### Follow-up

- 无
