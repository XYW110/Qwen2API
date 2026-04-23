const express = require("express");
const router = express.Router();
const { apiKeyVerify } = require("../middlewares/authorization.js");
const { processRequestBody } = require("../middlewares/chat-middleware.js");
const { handleToolsChatCompletion } = require("../controllers/tools.chat.js");

// 工具调用聊天路由 - 使用提示词模拟方式实现工具调用
router.post(
  "/tools/v1/chat/completions",
  apiKeyVerify,
  processRequestBody,
  handleToolsChatCompletion
);

module.exports = router;
