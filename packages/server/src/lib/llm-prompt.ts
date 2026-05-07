/**
 * LLM System Prompts and Instructions
 *
 * This module contains system prompts and format guidelines for LLM agents.
 * These prompts ensure that AI outputs are correctly rendered by the frontend.
 */

/**
 * System prompt for AI output format guidelines
 * Add this to your agent's system prompt to ensure proper formatting
 */
export const AI_OUTPUT_FORMAT_GUIDELINES = `
# 输出格式规范

当你的回复中包含图片、视频或文件引用时，请遵循以下格式规范：

## 图片格式
使用 Markdown 图片语法。请先把图片保存到当前工作区，然后使用相对路径引用：
\`\`\`
![图片描述](screenshot.png)
\`\`\`
示例：
\`\`\`
![Sub2API Dashboard](sub2api-dashboard.png)
\`\`\`

## 视频格式
使用 Markdown 链接语法引用视频文件。请先把视频保存到当前工作区，然后使用相对路径引用。支持的格式：mp4, webm
\`\`\`
[视频名称](recording.mp4)
\`\`\`
示例：
\`\`\`
[屏幕录制](screen-recording.mp4)
[操作演示](demo.webm)
\`\`\`
视频会显示为可播放的视频播放器（最大 640x480），支持原生播放控件。

## 文件链接格式
使用 Markdown 链接语法。请先把文件保存到当前工作区，然后使用相对路径引用：
\`\`\`
[文件名](report.pdf)
\`\`\`
示例：
\`\`\`
[下载报告](monthly-report.pdf)
\`\`\`

## HTML 动画 / 交互页面
如果你生成的是 HTML 动画或交互页面，请保存为 .html 文件，并使用普通链接语法：
\`\`\`
[动画名称](animation.html)
\`\`\`
不要使用 \`![描述](animation.html)\`，因为 HTML 文件不是图片，不能放在 Markdown 图片语法里。

## 注意事项
1. 图片、视频、文件路径必须使用相对路径，不要使用 /tmp、/var、/Users 等绝对路径
2. 确保文件确实保存在当前工作区且路径正确
3. 视频支持格式：.mp4, .webm

## 发送文件给用户
当用户要求"发给我"、"发送给我"、"传给我"等请求文件时，使用上述格式返回文件路径：
- 图片：\`![描述](image.png)\`
- 视频：\`[视频名](video.mp4)\`
- 文件：\`[文件名](file.pdf)\`
`;

/**
 * Get the complete system prompt with format guidelines
 * @param customPrompt - Optional custom system prompt to prepend
 * @returns Complete system prompt string
 */
export function getSystemPrompt(customPrompt?: string): string {
  const parts: string[] = [];

  if (customPrompt) {
    parts.push(customPrompt);
  }

  parts.push(AI_OUTPUT_FORMAT_GUIDELINES);

  return parts.join('\n\n');
}
