const { isJson, generateUUID } = require("../utils/tools.js");
const { createUsageObject } = require("../utils/precise-tokenizer.js");
const { sendChatRequest } = require("../utils/request.js");
const { logger } = require("../utils/logger");
const { handleChatCompletion } = require("../controllers/chat.js");
const {
  parseToolCalls,
  injectToolsIntoMessages,
  extractTextContent,
} = require("../utils/tools-simulator");

/**
 * 设置响应头
 * @param {object} res - Express 响应对象
 * @param {boolean} stream - 是否流式响应
 */
const setResponseHeaders = (res, stream) => {
  try {
    if (stream) {
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
    } else {
      res.set({
        "Content-Type": "application/json",
      });
    }
  } catch (e) {
    logger.error("设置工具调用响应头时发生错误", "TOOLS_CHAT", "", e);
  }
};

/**
 * 处理工具调用的流式响应
 * 缓冲内容以检测 <tool_call> 标记，将工具调用转换为 OpenAI 格式的 SSE chunk
 * @param {object} res - Express 响应对象
 * @param {object} response - 上游响应流
 * @param {object} requestBody - 原始请求体
 */
const handleToolsStreamResponse = async (res, response, requestBody = null) => {
  try {
    const message_id = generateUUID();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let contentBuffer = ""; // 用于缓冲文本内容以检测工具调用
    let inToolCall = false;
    let toolCallBuffer = "";
    let emittedToolCalls = false;
    let toolCallIndex = 0;

    // Token消耗量统计
    let totalTokens = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };
    let completionContent = "";

    // 提取prompt文本用于token估算
    let promptText = "";
    if (requestBody && requestBody.messages) {
      promptText = requestBody.messages
        .map((msg) => {
          if (typeof msg.content === "string") {
            return msg.content;
          } else if (Array.isArray(msg.content)) {
            return msg.content.map((item) => item.text || "").join("");
          }
          return "";
        })
        .join("\n");
    }

    response.on("data", async (chunk) => {
      try {
        const decodeText = decoder.decode(chunk, { stream: true });
        buffer += decodeText;

        const chunks = [];
        let startIndex = 0;

        while (true) {
          const dataStart = buffer.indexOf("data: ", startIndex);
          if (dataStart === -1) break;

          const dataEnd = buffer.indexOf("\n\n", dataStart);
          if (dataEnd === -1) break;

          const dataChunk = buffer.substring(dataStart, dataEnd).trim();
          chunks.push(dataChunk);

          startIndex = dataEnd + 2;
        }

        if (startIndex > 0) {
          buffer = buffer.substring(startIndex);
        }

        for (const item of chunks) {
          try {
            let dataContent = item.replace("data: ", "");
            let decodeJson = isJson(dataContent)
              ? JSON.parse(dataContent)
              : null;
            if (
              decodeJson === null ||
              !decodeJson.choices ||
              decodeJson.choices.length === 0
            ) {
              continue;
            }

            // 提取真实的usage信息
            if (decodeJson.usage) {
              totalTokens = {
                prompt_tokens:
                  decodeJson.usage.prompt_tokens || totalTokens.prompt_tokens,
                completion_tokens:
                  decodeJson.usage.completion_tokens ||
                  totalTokens.completion_tokens,
                total_tokens:
                  decodeJson.usage.total_tokens || totalTokens.total_tokens,
              };
            }

            const delta = decodeJson.choices[0].delta;
            if (!delta || !delta.content) {
              continue;
            }

            const content = delta.content;
            completionContent += content;

            // 处理内容缓冲和工具调用检测
            if (!inToolCall) {
              contentBuffer += content;

              // 检测 <tool_call> 开始标记
              const toolCallStart = contentBuffer.indexOf("<tool_call>");
              if (toolCallStart !== -1) {
                // 输出工具调用之前的文本内容
                const textBeforeTool = contentBuffer
                  .substring(0, toolCallStart)
                  .trim();
                if (textBeforeTool) {
                  const textChunk = {
                    id: `chatcmpl-${message_id}`,
                    object: "chat.completion.chunk",
                    created: Math.round(new Date().getTime() / 1000),
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content: textBeforeTool,
                        },
                        finish_reason: null,
                      },
                    ],
                  };
                  res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
                }

                inToolCall = true;
                toolCallBuffer = contentBuffer.substring(
                  toolCallStart + "<tool_call>".length
                );
                contentBuffer = "";
              } else {
                // 检查是否有可能包含不完整的 <tool_call> 标记
                // 保留最后 20 个字符用于检测跨 chunk 的不完整标记
                const keepLength = 20;
                if (contentBuffer.length > keepLength) {
                  const emitText = contentBuffer.substring(
                    0,
                    contentBuffer.length - keepLength
                  );
                  contentBuffer = contentBuffer.substring(
                    contentBuffer.length - keepLength
                  );

                  if (emitText) {
                    const textChunk = {
                      id: `chatcmpl-${message_id}`,
                      object: "chat.completion.chunk",
                      created: Math.round(new Date().getTime() / 1000),
                      choices: [
                        {
                          index: 0,
                          delta: {
                            content: emitText,
                          },
                          finish_reason: null,
                        },
                      ],
                    };
                    res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
                  }
                }
              }
            } else {
              // 正在收集工具调用内容
              toolCallBuffer += content;

              // 检测 </tool_call> 结束标记
              const toolCallEnd = toolCallBuffer.indexOf("</tool_call>");
              if (toolCallEnd !== -1) {
                // 提取完整的工具调用 JSON
                const toolCallJson = toolCallBuffer
                  .substring(0, toolCallEnd)
                  .trim();

                try {
                  const parsed = JSON.parse(toolCallJson);
                  if (parsed.name && typeof parsed.name === "string") {
                    const toolCallChunk = {
                      id: `chatcmpl-${message_id}`,
                      object: "chat.completion.chunk",
                      created: Math.round(new Date().getTime() / 1000),
                      choices: [
                        {
                          index: 0,
                          delta: {
                            tool_calls: [
                              {
                                index: toolCallIndex,
                                id: `call_${String(toolCallIndex).padStart(
                                  9,
                                  "0"
                                )}`,
                                type: "function",
                                function: {
                                  name: parsed.name,
                                  arguments:
                                    typeof parsed.arguments === "object"
                                      ? JSON.stringify(parsed.arguments)
                                      : String(parsed.arguments || "{}"),
                                },
                              },
                            ],
                          },
                          finish_reason: null,
                        },
                      ],
                    };
                    res.write(`data: ${JSON.stringify(toolCallChunk)}\n\n`);
                    emittedToolCalls = true;
                    toolCallIndex++;
                  }
                } catch (parseError) {
                  logger.warn(
                    `Failed to parse tool call in stream: ${parseError.message}`,
                    "TOOLS_CHAT",
                    "⚠️"
                  );
                }

                // 处理 </tool_call> 之后的内容
                const afterToolCall = toolCallBuffer.substring(
                  toolCallEnd + "</tool_call>".length
                );
                inToolCall = false;
                toolCallBuffer = "";
                contentBuffer = afterToolCall;
              }
            }
          } catch (error) {
            logger.error("工具调用流式数据处理错误", "TOOLS_CHAT", "", error);
          }
        }
      } catch (error) {
        logger.error("工具调用流式数据解码错误", "TOOLS_CHAT", "", error);
        res.status(500).json({ error: "服务错误!!!" });
      }
    });

    response.on("end", async () => {
      try {
        // 处理剩余缓冲内容
        if (!inToolCall && contentBuffer.trim()) {
          const textChunk = {
            id: `chatcmpl-${message_id}`,
            object: "chat.completion.chunk",
            created: Math.round(new Date().getTime() / 1000),
            choices: [
              {
                index: 0,
                delta: {
                  content: contentBuffer.trim(),
                },
                finish_reason: null,
              },
            ],
          };
          res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
        }

        // 计算最终的token使用量
        if (
          totalTokens.prompt_tokens === 0 &&
          totalTokens.completion_tokens === 0
        ) {
          totalTokens = createUsageObject(
            requestBody?.messages || promptText,
            completionContent,
            null
          );
          logger.info(
            `工具调用流式使用tiktoken计算 - Prompt: ${totalTokens.prompt_tokens}, Completion: ${totalTokens.completion_tokens}, Total: ${totalTokens.total_tokens}`,
            "TOOLS_CHAT"
          );
        } else {
          logger.info(
            `工具调用流式使用上游真实Token - Prompt: ${totalTokens.prompt_tokens}, Completion: ${totalTokens.completion_tokens}, Total: ${totalTokens.total_tokens}`,
            "TOOLS_CHAT"
          );
        }

        // 确保token数量的有效性
        totalTokens.prompt_tokens = Math.max(0, totalTokens.prompt_tokens || 0);
        totalTokens.completion_tokens = Math.max(
          0,
          totalTokens.completion_tokens || 0
        );
        totalTokens.total_tokens =
          totalTokens.prompt_tokens + totalTokens.completion_tokens;

        // 发送最终的finish chunk
        const finishReason = emittedToolCalls ? "tool_calls" : "stop";
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${message_id}`,
            object: "chat.completion.chunk",
            created: Math.round(new Date().getTime() / 1000),
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: finishReason,
              },
            ],
          })}\n\n`
        );

        // 发送usage信息chunk
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${message_id}`,
            object: "chat.completion.chunk",
            created: Math.round(new Date().getTime() / 1000),
            choices: [],
            usage: totalTokens,
          })}\n\n`
        );

        // 发送结束标记
        res.write(`data: [DONE]\n\n`);
        res.end();
      } catch (e) {
        logger.error("工具调用流式响应处理错误", "TOOLS_CHAT", "", e);
        res.status(500).json({ error: "服务错误!!!" });
      }
    });
  } catch (error) {
    logger.error("工具调用聊天处理错误", "TOOLS_CHAT", "", error);
    res.status(500).json({ error: "服务错误!!!" });
  }
};

/**
 * 处理工具调用的非流式响应
 * 累积完整响应内容，解析 <tool_call> 标记，返回 OpenAI 兼容格式
 * @param {object} res - Express 响应对象
 * @param {object} response - 上游响应流
 * @param {string} model - 模型名称
 * @param {object} requestBody - 原始请求体
 */
const handleToolsNonStreamResponse = async (
  res,
  response,
  model,
  requestBody = null
) => {
  try {
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullContent = "";

    // Token消耗量统计
    let totalTokens = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    // 提取prompt文本用于token估算
    let promptText = "";
    if (requestBody && requestBody.messages) {
      promptText = requestBody.messages
        .map((msg) => {
          if (typeof msg.content === "string") {
            return msg.content;
          } else if (Array.isArray(msg.content)) {
            return msg.content.map((item) => item.text || "").join("");
          }
          return "";
        })
        .join("\n");
    }

    // 处理流式响应并累积内容
    await new Promise((resolve, reject) => {
      response.on("data", async (chunk) => {
        try {
          const decodeText = decoder.decode(chunk, { stream: true });
          buffer += decodeText;

          const chunks = [];
          let startIndex = 0;

          while (true) {
            const dataStart = buffer.indexOf("data: ", startIndex);
            if (dataStart === -1) break;

            const dataEnd = buffer.indexOf("\n\n", dataStart);
            if (dataEnd === -1) break;

            const dataChunk = buffer.substring(dataStart, dataEnd).trim();
            chunks.push(dataChunk);

            startIndex = dataEnd + 2;
          }

          if (startIndex > 0) {
            buffer = buffer.substring(startIndex);
          }

          for (const item of chunks) {
            try {
              let dataContent = item.replace("data: ", "");
              let decodeJson = isJson(dataContent)
                ? JSON.parse(dataContent)
                : null;
              if (
                decodeJson === null ||
                !decodeJson.choices ||
                decodeJson.choices.length === 0
              ) {
                continue;
              }

              // 提取真实的usage信息
              if (decodeJson.usage) {
                totalTokens = {
                  prompt_tokens:
                    decodeJson.usage.prompt_tokens || totalTokens.prompt_tokens,
                  completion_tokens:
                    decodeJson.usage.completion_tokens ||
                    totalTokens.completion_tokens,
                  total_tokens:
                    decodeJson.usage.total_tokens || totalTokens.total_tokens,
                };
              }

              const delta = decodeJson.choices[0].delta;
              if (!delta || !delta.content) {
                continue;
              }

              fullContent += delta.content;
            } catch (error) {
              logger.error(
                "工具调用非流式数据处理错误",
                "TOOLS_CHAT",
                "",
                error
              );
            }
          }
        } catch (error) {
          logger.error("工具调用非流式数据解码错误", "TOOLS_CHAT", "", error);
        }
      });

      response.on("end", () => {
        resolve();
      });

      response.on("error", (error) => {
        logger.error("工具调用非流式响应流读取错误", "TOOLS_CHAT", "", error);
        reject(error);
      });
    });

    // 解析工具调用
    const toolCalls = parseToolCalls(fullContent);
    const hasToolCalls = toolCalls.length > 0;

    // 提取纯文本内容（移除工具调用标记）
    const textContent = extractTextContent(fullContent);

    // 计算最终的token使用量
    if (
      totalTokens.prompt_tokens === 0 &&
      totalTokens.completion_tokens === 0
    ) {
      totalTokens = createUsageObject(
        requestBody?.messages || promptText,
        fullContent,
        null
      );
      logger.info(
        `工具调用非流式使用tiktoken计算 - Prompt: ${totalTokens.prompt_tokens}, Completion: ${totalTokens.completion_tokens}, Total: ${totalTokens.total_tokens}`,
        "TOOLS_CHAT"
      );
    } else {
      logger.info(
        `工具调用非流式使用上游真实Token - Prompt: ${totalTokens.prompt_tokens}, Completion: ${totalTokens.completion_tokens}, Total: ${totalTokens.total_tokens}`,
        "TOOLS_CHAT"
      );
    }

    // 确保token数量的有效性
    totalTokens.prompt_tokens = Math.max(0, totalTokens.prompt_tokens || 0);
    totalTokens.completion_tokens = Math.max(
      0,
      totalTokens.completion_tokens || 0
    );
    totalTokens.total_tokens =
      totalTokens.prompt_tokens + totalTokens.completion_tokens;

    // 构建响应
    const finishReason = hasToolCalls ? "tool_calls" : "stop";
    const messageContent = hasToolCalls ? null : textContent || fullContent;

    const bodyTemplate = {
      id: `chatcmpl-${generateUUID()}`,
      object: "chat.completion",
      created: Math.round(new Date().getTime() / 1000),
      model: model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: messageContent,
            ...(hasToolCalls && { tool_calls: toolCalls }),
          },
          finish_reason: finishReason,
        },
      ],
      usage: totalTokens,
    };

    res.json(bodyTemplate);
  } catch (error) {
    logger.error("工具调用非流式聊天处理错误", "TOOLS_CHAT", "", error);
    res.status(500).json({
      error: "服务错误!!!",
    });
  }
};

/**
 * 工具调用聊天完成处理函数
 * 通过提示词模拟方式实现工具调用，兼容 OpenAI 工具调用 API
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 */
const handleToolsChatCompletion = async (req, res) => {
  const { tools, tool_choice, messages, stream, model } = req.body;

  try {
    // 验证必要参数
    if (!Array.isArray(tools) || tools.length === 0) {
      // 没有工具时，直接回退到正常聊天逻辑
      return handleChatCompletion(req, res);
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({
        error: "messages 参数无效或为空",
      });
      return;
    }
    const injectedMessages = injectToolsIntoMessages(
      messages,
      tools,
      tool_choice
    );

    // 构建请求体（复用主聊天的格式）
    const requestBody = {
      ...req.body,
      messages: injectedMessages,
      stream: true, // 上游始终使用流式
    };

    logger.info(
      `发送工具调用聊天请求，工具数量: ${tools.length}`,
      "TOOLS_CHAT"
    );

    // 发送请求
    const response_data = await sendChatRequest(requestBody);

    if (!response_data.status || !response_data.response) {
      res.status(500).json({
        error: "请求发送失败！！！",
      });
      return;
    }

    // 根据客户端请求的 stream 参数决定响应方式
    if (stream) {
      setResponseHeaders(res, true);
      await handleToolsStreamResponse(res, response_data.response, req.body);
    } else {
      setResponseHeaders(res, false);
      await handleToolsNonStreamResponse(
        res,
        response_data.response,
        model,
        req.body
      );
    }
  } catch (error) {
    logger.error("工具调用聊天处理错误", "TOOLS_CHAT", "", error);
    res.status(500).json({
      error: "token无效,请求发送失败！！！",
    });
  }
};

module.exports = {
  handleToolsChatCompletion,
  handleToolsStreamResponse,
  handleToolsNonStreamResponse,
  setResponseHeaders,
};
