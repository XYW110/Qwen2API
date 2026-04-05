const axios = require('axios')
const { logger } = require('../utils/logger.js')
const { setResponseHeaders } = require('./chat.js')
const accountManager = require('../utils/account.js')
const { sleep } = require('../utils/tools.js')
const { generateChatID } = require('../utils/request.js')
const { getSsxmodItna, getSsxmodItna2 } = require('../utils/ssxmod-manager')
const { getProxyAgent, getChatBaseUrl, applyProxyToAxiosConfig } = require('../utils/proxy-helper')

const parseUpstreamImageError = (data) => {
    try {
        let payload = data

        if (Array.isArray(payload) && payload.length > 0) {
            payload = payload[0]
        }

        if (typeof payload === 'string') {
            payload = JSON.parse(payload)
        }

        // 只有明确 success=false 且带错误码时，才按上游错误包处理，避免误伤正常业务响应
        if (!payload || payload.success !== false || !payload.data?.code) {
            return null
        }

        const errorData = payload.data
        if (errorData.code === 'RateLimited') {
            const waitHours = errorData.num
            logger.error(`图片/视频生成额度已用尽，需等待约 ${waitHours || '未知'} 小时`, 'CHAT', '', errorData)
            return {
                error: `当前账号的该功能使用次数已达上限，${waitHours ? `请等待约 ${waitHours} 小时后再试` : '请稍后再试'}`,
                code: errorData.code,
                wait_hours: waitHours
            }
        }

        logger.error('请求上游服务时出现错误', 'CHAT', '', errorData)
        return {
            error: errorData.details || errorData.code || '服务错误，请稍后再试',
            code: errorData.code
        }
    } catch (e) {
        return null
    }
}

const parseUpstreamImageErrorFromText = (text) => {
    try {
        if (!text || typeof text !== 'string') {
            return null
        }

        // 图片接口在额度耗尽时可能返回普通 JSON 文本而不是 SSE，需要在流结束后补做一次识别
        return parseUpstreamImageError(JSON.parse(text))
    } catch (e) {
        return null
    }
}

/**
 * 主要的聊天完成处理函数
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 */
const handleImageVideoCompletion = async (req, res) => {
    const { model, messages, size, chat_type } = req.body
    // console.log(JSON.stringify(req.body.messages.filter(item => item.role == "user" || item.role == "assistant")))
    const token = accountManager.getAccountToken()

    try {

        // 请求体模板
        const reqBody = {
            "stream": true,
            "version": "2.1",
            "incremental_output": true,
            "chat_id": null,
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": "",
                    "files": [],
                    "chat_type": chat_type,
                    "feature_config": {
                        "output_schema": "phase"
                    }
                }
            ]
        }

        const chat_id = await generateChatID(token, model)

        if (!chat_id) {
            // 如果生成chat_id失败，则返回错误
            throw new Error()
        } else {
            reqBody.chat_id = chat_id
        }

        // 拿到用户最后一句消息
        const _userPrompt = messages[messages.length - 1].content
        if (!_userPrompt) {
            throw new Error()
        }

        // 提取历史消息
        const messagesHistory = messages.filter(item => item.role == "user" || item.role == "assistant")
        // 聊天消息中所有图片url
        const select_image_list = []

        // 遍历模型回复消息，拿到所有图片
        if (chat_type == "image_edit") {
            for (const item of messagesHistory) {
                if (item.role == "assistant") {
                    // 使用matchAll提取所有图片链接
                    const matches = [...item.content.matchAll(/!\[image\]\((.*?)\)/g)]
                    // 将所有匹配到的图片url添加到图片列表
                    for (const match of matches) {
                        select_image_list.push(match[1])
                    }
                } else {
                    if (Array.isArray(item.content) && item.content.length > 0) {
                        for (const content of item.content) {
                            if (content.type == "image") {
                                select_image_list.push(content.image)
                            }
                        }
                    }
                }
            }
        }

        //分情况处理
        if (chat_type == 't2i' || chat_type == 't2v') {
            if (Array.isArray(_userPrompt)) {
                reqBody.messages[0].content = _userPrompt.map(item => item.type == "text" ? item.text : "").join("\n\n")
            } else {
                reqBody.messages[0].content = _userPrompt
            }
        } else if (chat_type == 'image_edit') {
            if (!Array.isArray(_userPrompt)) {

                if (messagesHistory.length === 1) {
                    reqBody.messages[0].chat_type = "t2i"
                } else if (select_image_list.length >= 1) {
                    reqBody.messages[0].files.push({
                        "type": "image",
                        "url": select_image_list[select_image_list.length - 1]
                    })
                }
                reqBody.messages[0].content += _userPrompt
            } else {
                const texts = _userPrompt.filter(item => item.type == "text")
                if (texts.length === 0) {
                    throw new Error()
                }
                // 拼接提示词
                for (const item of texts) {
                    reqBody.messages[0].content += item.text
                }

                const files = _userPrompt.filter(item => item.type == "image")
                // 如果图片为空，则设置为t2i
                if (files.length === 0) {
                    reqBody.messages[0].chat_type = "t2i"
                }
                // 遍历图片
                for (const item of files) {
                    reqBody.messages[0].files.push({
                        "type": "image",
                        "url": item.image
                    })
                }

            }
        }


        // 处理图片视频尺寸
        if (chat_type == 't2i' || chat_type == 't2v') {
            // 获取图片尺寸，优先级 参数 > 提示词 > 默认
            if (size != undefined && size != null) {
                reqBody.size = size
            } else if (typeof _userPrompt === 'string' && _userPrompt.indexOf("@4:3") != -1) {
                reqBody.size = "4:3"//"1024*768"
            } else if (typeof _userPrompt === 'string' && _userPrompt.indexOf("@3:4") != -1) {
                reqBody.size = "3:4"//"768*1024"
            } else if (typeof _userPrompt === 'string' && _userPrompt.indexOf("@16:9") != -1) {
                reqBody.size = "16:9"//"1280*720"
            } else if (typeof _userPrompt === 'string' && _userPrompt.indexOf("@9:16") != -1) {
                reqBody.size = "9:16"//"720*1280"
            }
        }

        if (chat_type == 't2v') {
            // 视频提交接口返回同步 JSON，这里保持非流式请求，后续再轮询任务状态
            reqBody.stream = false
        }

        const chatBaseUrl = getChatBaseUrl()
        const proxyAgent = getProxyAgent()

        logger.info('发送图片视频请求', 'CHAT')
        logger.info(`选择图片: ${select_image_list[select_image_list.length - 1] || "未选择图片，切换生成图/视频模式"}`, 'CHAT')
        logger.info(`使用提示: ${reqBody.messages[0].content}`, 'CHAT')
        // console.log(JSON.stringify(reqBody))
        const newChatType = reqBody.messages[0].chat_type

        const requestConfig = {
            headers: {
                'Authorization': `Bearer ${token}`,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
                "Connection": "keep-alive",
                "Accept": "application/json",
                "Accept-Encoding": "gzip, deflate, br, zstd",
                "Content-Type": "application/json",
                "Timezone": "Mon Dec 08 2025 17:28:55 GMT+0800",
                "sec-ch-ua": "\"Microsoft Edge\";v=\"143\", \"Chromium\";v=\"143\", \"Not A(Brand\";v=\"24\"",
                "source": "web",
                "Version": "0.1.13",
                "bx-v": "2.5.31",
                "Origin": chatBaseUrl,
                "Sec-Fetch-Site": "same-origin",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Dest": "empty",
                "Referer": `${chatBaseUrl}/c/guest`,
                "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
                "Cookie": `ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`,
            },
            responseType: newChatType == 't2v' ? 'json' : 'stream',
            timeout: 1000 * 60 * 5
        }

        // 添加代理配置
        if (proxyAgent) {
            requestConfig.httpsAgent = proxyAgent
            requestConfig.proxy = false
        }

        const response_data = await axios.post(`${chatBaseUrl}/api/v2/chat/completions?chat_id=${chat_id}`, reqBody, requestConfig)

        try {
            let contentUrl = null
            if (newChatType == 't2i' || newChatType == 'image_edit') {
                const decoder = new TextDecoder('utf-8')
                // 使用 buffer 累积 SSE 分片，避免单个 data 事件被拆包时 JSON 解析失败
                let buffer = ''
                let rawText = ''
                response_data.data.on('data', async (chunk) => {
                    const decoded = decoder.decode(chunk, { stream: true })
                    rawText += decoded
                    buffer += decoded
                    const events = buffer.split('\n\n')
                    buffer = events.pop() || ''

                    for (const event of events) {
                        const dataLine = event.split('\n').find(item => item.trim().startsWith('data:'))
                        if (!dataLine) {
                            continue
                        }

                        const payload = dataLine.replace(/^data:\s*/, '').trim()
                        if (!payload) {
                            continue
                        }

                        try {
                            const jsonObj = JSON.parse(payload)
                            if (jsonObj && jsonObj.choices && jsonObj.choices[0] && jsonObj.choices[0].delta && typeof jsonObj.choices[0].delta.content === 'string' && jsonObj.choices[0].delta.content.trim() != "" && contentUrl == null) {
                                contentUrl = jsonObj.choices[0].delta.content
                            }
                        } catch (error) {
                            logger.error('图片SSE解析失败', 'CHAT', '', error)
                        }
                    }
                })

                response_data.data.on('end', () => {
                    // 某些失败场景会上游直接返回 JSON 文本，这里优先透传真实错误，再回退到图片链接响应
                    const upstreamError = parseUpstreamImageErrorFromText(rawText.trim())
                    if (upstreamError) {
                        return res.status(429).json(upstreamError)
                    }
                    return returnResponse(res, model, contentUrl, req.body.stream)
                })
            } else if (newChatType == 't2v') {
                return handleVideoCompletion(req, res, response_data.data, token)
            }

        } catch (error) {
            logger.error('图片处理错误', 'CHAT', '', error)
            res.status(500).json({ error: "服务错误!!!" })
        }

    } catch (error) {
        const upstreamError = parseUpstreamImageError(error.response?.data)
        if (upstreamError) {
            return res.status(429).json(upstreamError)
        }

        res.status(500).json({
            error: "服务错误，请稍后再试"
        })
    }
}

/**
 * 返回响应
 * @param {*} res 
 * @param {*} model 
 * @param {*} contentUrl 
 */
const returnResponse = (res, model, contentUrl, stream) => {
    setResponseHeaders(res, stream)
    logger.info(`返回响应: ${contentUrl}`, 'CHAT')

    const returnBody = {
        "created": new Date().getTime(),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": `![image](${contentUrl})`
                }
            }
        ]
    }

    if (stream) {
        res.write(`data: ${JSON.stringify(returnBody)}\n\n`)
        res.write(`data: [DONE]\n\n`)
        res.end()
    } else {
        res.json(returnBody)
    }
}

const handleVideoCompletion = async (req, res, response_data, token) => {
    try {
        // 视频生成失败时与图片共用同一套上游错误模板解析
        const upstreamError = parseUpstreamImageError(response_data)
        if (upstreamError) {
            return res.status(429).json(upstreamError)
        }

        const videoTaskID = response_data?.data?.messages[0]?.extra?.wanx?.task_id
        if (!response_data || !response_data.success || !videoTaskID) {
            throw new Error()
        }

        logger.info(`视频任务ID: ${videoTaskID}`, 'CHAT')
        const returnBody = {
            "id": `chatcmpl-${new Date().getTime()}`,
            "object": "chat.completion.chunk",
            "created": new Date().getTime(),
            "model": response_data.data.model,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": ""
                    },
                    "finish_reason": null
                }
            ]
        }

        // 设置尝试次数
        const maxAttempts = 60
        // 设置每次请求的间隔时间
        const delay = 20 * 1000
        let headersInitialized = false
        // 循环尝试获取任务状态
        for (let i = 0; i < maxAttempts; i++) {
            const content = await getVideoTaskStatus(videoTaskID, token)
            if (content) {
                returnBody.choices[0].message.content = `
<video controls = "controls">
${content}
</video>

[Download Video](${content})
`
                // 设置响应头
                if (!headersInitialized && !res.headersSent) {
                    setResponseHeaders(res, req.body.stream)
                    headersInitialized = true
                }

                if (req.body.stream) {
                    res.write(`data: ${JSON.stringify(returnBody)}\n\n`)
                    res.write(`data: [DONE]\n\n`)
                    res.end()
                } else {
                    res.json(returnBody)
                }
                return
            } else if (content == null && req.body.stream) {
                // 视频生成耗时较长，流式模式下定期发送空 chunk 保活，避免下游连接超时
                if (!headersInitialized && !res.headersSent) {
                    setResponseHeaders(res, req.body.stream)
                    headersInitialized = true
                }
                res.write(`data: ${JSON.stringify(returnBody)}\n\n`)
            }

            await sleep(delay)
        }
    } catch (error) {
        logger.error('获取视频任务状态失败', 'CHAT', '', error)
        res.status(500).json({ error: error.response?.data?.data?.code || "可能该帐号今日生成次数已用完" })
    }
}

const getVideoTaskStatus = async (videoTaskID, token) => {
    try {
        const chatBaseUrl = getChatBaseUrl()
        const proxyAgent = getProxyAgent()

        const requestConfig = {
            headers: {
                "Authorization": `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ...(getSsxmodItna() && { 'Cookie': `ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}` })
            }
        }

        // 添加代理配置
        if (proxyAgent) {
            requestConfig.httpsAgent = proxyAgent
            requestConfig.proxy = false
        }

        const response_data = await axios.get(`${chatBaseUrl}/api/v1/tasks/status/${videoTaskID}`, requestConfig)

        if (response_data.data?.task_status == "success") {
            logger.info('获取视频任务状态成功', 'CHAT', response_data.data?.content)
            return response_data.data?.content
        }
        logger.info(`获取视频任务 ${videoTaskID} 状态: ${response_data.data?.task_status}`, 'CHAT')
        return null
    } catch (error) {
        console.log(error.response?.data)
        return null
    }
}

module.exports = {
    handleImageVideoCompletion
}
