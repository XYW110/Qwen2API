const { logger } = require('./logger')

/**
 * 工具调用模拟器
 * 通过提示词方式让模型输出结构化的工具调用，然后解析为 OpenAI 兼容格式
 * 上游 chat.qwen.ai 已限制原生 tools 参数支持，需要使用此模拟器
 */

/**
 * 生成工具提示词
 * 将 OpenAI tools 数组转换为系统提示词中的函数描述
 * @param {Array} tools - OpenAI tools 数组 [{type: 'function', function: {name, description, parameters}}]
 * @returns {string} 格式化的工具描述字符串
 */
function buildToolPrompt(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return ''
  }

  try {
    const toolDescriptions = tools.map(tool => {
      if (tool.type !== 'function' || !tool.function) {
        return ''
      }

      const { name, description, parameters } = tool.function
      const paramsStr = parameters ? JSON.stringify(parameters) : '{}'

      return `## ${name}\n${description || ''}\nParameters: ${paramsStr}`
    }).filter(Boolean)

    if (toolDescriptions.length === 0) {
      return ''
    }

    const prompt = `You have access to the following tools. When you need to call a tool, wrap your tool call in <tool_call> tags:

<tools>
${toolDescriptions.join('\n\n')}
</tools>

To call a tool, respond with:
<tool_call>
{"name": "tool_name", "arguments": {"arg1": "value1"}}
</tool_call>`

    logger.debug('Generated tool prompt', 'tools-simulator', '🔧', { toolCount: tools.length })
    return prompt
  } catch (error) {
    logger.error('Failed to build tool prompt', 'tools-simulator', '❌', error.message)
    return ''
  }
}

/**
 * 从模型响应文本中解析工具调用
 * 支持两种格式:
 * 1. XML格式: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
 * 2. qwen2API格式: ##TOOL_CALL##\n{"name": "...", "arguments": {...}}\n##END_CALL##
 * @param {string} content - 模型响应文本
 * @returns {Array} OpenAI格式的工具调用数组 [{id, type, function: {name, arguments}}]
 */
function parseToolCalls(content) {
  if (!content || typeof content !== 'string') {
    return []
  }

  const toolCalls = []
  let callId = 0

  try {
    // 解析 XML 格式: <tool_call>...</tool_call>
    const xmlRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
    let xmlMatch
    while ((xmlMatch = xmlRegex.exec(content)) !== null) {
      try {
        const jsonStr = xmlMatch[1].trim()
        const parsed = JSON.parse(jsonStr)

        if (parsed.name && typeof parsed.name === 'string') {
          toolCalls.push({
            id: `call_${String(callId).padStart(9, '0')}`,
            type: 'function',
            function: {
              name: parsed.name,
              arguments: typeof parsed.arguments === 'object'
                ? JSON.stringify(parsed.arguments)
                : String(parsed.arguments || '{}')
            }
          })
          callId++
        }
      } catch (parseError) {
        logger.warn(`Failed to parse XML tool call: ${parseError.message}`, 'tools-simulator', '⚠️')
      }
    }

    // 解析 qwen2API 格式: ##TOOL_CALL##\n...\n##END_CALL##
    const qwenRegex = /##TOOL_CALL##\s*\n?([\s\S]*?)\n?\s*##END_CALL##/g
    let qwenMatch
    while ((qwenMatch = qwenRegex.exec(content)) !== null) {
      try {
        const jsonStr = qwenMatch[1].trim()
        const parsed = JSON.parse(jsonStr)

        if (parsed.name && typeof parsed.name === 'string') {
          toolCalls.push({
            id: `call_${String(callId).padStart(9, '0')}`,
            type: 'function',
            function: {
              name: parsed.name,
              arguments: typeof parsed.arguments === 'object'
                ? JSON.stringify(parsed.arguments)
                : String(parsed.arguments || '{}')
            }
          })
          callId++
        }
      } catch (parseError) {
        logger.warn(`Failed to parse qwen2API tool call: ${parseError.message}`, 'tools-simulator', '⚠️')
      }
    }

    if (toolCalls.length > 0) {
      logger.debug(`Parsed ${toolCalls.length} tool calls`, 'tools-simulator', '🔧', toolCalls.map(tc => tc.function.name))
    }

    return toolCalls
  } catch (error) {
    logger.error('Failed to parse tool calls', 'tools-simulator', '❌', error.message)
    return []
  }
}

/**
 * 构建工具结果消息
 * @param {string} toolCallId - 工具调用ID
 * @param {any} result - 工具执行结果
 * @returns {Object} OpenAI格式的工具结果消息 {role: 'tool', tool_call_id, content}
 */
function buildToolResultMessage(toolCallId, result) {
  try {
    const content = typeof result === 'string' ? result : JSON.stringify(result)

    return {
      role: 'tool',
      tool_call_id: toolCallId,
      content
    }
  } catch (error) {
    logger.error('Failed to build tool result message', 'tools-simulator', '❌', error.message)
    return {
      role: 'tool',
      tool_call_id: toolCallId,
      content: String(result)
    }
  }
}

/**
 * 将工具描述注入消息数组
 * 在第一个 system 消息中追加工具提示词，如果没有 system 消息则在开头添加
 * @param {Array} messages - OpenAI messages 数组
 * @param {Array} tools - OpenAI tools 数组
 * @param {string|Object} toolChoice - tool_choice 参数 (auto/none/required/特定函数名)
 * @returns {Array} 修改后的 messages 数组
 */
function injectToolsIntoMessages(messages, tools, toolChoice = 'auto') {
  if (!Array.isArray(messages)) {
    logger.warn('Invalid messages array', 'tools-simulator', '⚠️')
    return messages
  }

  if (!Array.isArray(tools) || tools.length === 0) {
    return messages
  }

  try {
    const toolPrompt = buildToolPrompt(tools)
    if (!toolPrompt) {
      return messages
    }

    // 处理 tool_choice
    let toolChoicePrompt = ''
    if (toolChoice === 'none') {
      toolChoicePrompt = '\n\nNote: You must NOT use any tools for this request.'
    } else if (toolChoice === 'required') {
      toolChoicePrompt = '\n\nNote: You MUST use a tool for this request.'
    } else if (toolChoice === 'auto') {
      toolChoicePrompt = '\n\nNote: Use tools only when necessary.'
    } else if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
      toolChoicePrompt = `\n\nNote: You MUST use the \`${toolChoice.function.name}\` tool for this request.`
    } else if (typeof toolChoice === 'string' && toolChoice !== 'auto') {
      toolChoicePrompt = `\n\nNote: You MUST use the \`${toolChoice}\` tool for this request.`
    }

    const fullPrompt = toolPrompt + toolChoicePrompt

    // 查找第一个 system 消息
    const systemIndex = messages.findIndex(msg => msg && msg.role === 'system')

    const newMessages = [...messages]

    if (systemIndex !== -1) {
      // 在现有 system 消息中追加工具提示词
      const originalContent = newMessages[systemIndex].content || ''
      newMessages[systemIndex] = {
        ...newMessages[systemIndex],
        content: originalContent + '\n\n' + fullPrompt
      }
      logger.debug('Injected tools into existing system message', 'tools-simulator', '🔧')
    } else {
      // 在开头添加新的 system 消息
      newMessages.unshift({
        role: 'system',
        content: fullPrompt
      })
      logger.debug('Added new system message with tools', 'tools-simulator', '🔧')
    }

    return newMessages
  } catch (error) {
    logger.error('Failed to inject tools into messages', 'tools-simulator', '❌', error.message)
    return messages
  }
}

/**
 * 从可能包含工具调用的内容中提取纯文本
 * 移除 <tool_call>...</tool_call> 和 ##TOOL_CALL##...##END_CALL## 块
 * @param {string} content - 可能包含工具调用的文本
 * @returns {string} 清理后的纯文本
 */
function extractTextContent(content) {
  if (!content || typeof content !== 'string') {
    return ''
  }

  try {
    // 移除 XML 格式工具调用
    let cleaned = content.replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/g, '')

    // 移除 qwen2API 格式工具调用
    cleaned = cleaned.replace(/##TOOL_CALL##\s*\n?[\s\S]*?\n?\s*##END_CALL##/g, '')

    // 清理多余空白
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim()

    return cleaned
  } catch (error) {
    logger.error('Failed to extract text content', 'tools-simulator', '❌', error.message)
    return content
  }
}

module.exports = {
  buildToolPrompt,
  parseToolCalls,
  buildToolResultMessage,
  injectToolsIntoMessages,
  extractTextContent
}
