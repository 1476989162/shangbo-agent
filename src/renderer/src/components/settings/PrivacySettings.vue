<template>
  <section class="content-pane">
    <div class="privacy-banner-card">
      <p class="banner-text">
        您当前正通过本机及您指定的推理提供商（127.0.0.1 / 本地私有网关）运行尚搏 Agent。您的所有会话、文件与工作区内容均直接发送至您配置的端点，绝不会被转存或上传至任何第三方云端。
      </p>

      <div class="privacy-item-group">
        <h4 class="privacy-group-title">完全留在本机的核心隐私数据（绝不外传）：</h4>
        <ul class="privacy-bullet-list">
          <li>您的提问 Prompt、助手的回答及完整的会话历史树</li>
          <li>您的本地工程文件、代码内容及工作区目录数据</li>
          <li>您的本机操作系统账户与身份细节</li>
        </ul>
      </div>

      <div class="privacy-item-group">
        <h4 class="privacy-group-title">网关及调试诊断信息（仅本地安全保管）：</h4>
        <ul class="privacy-bullet-list">
          <li>本机运行时错误与崩溃诊断日志，用于故障定位</li>
          <li>匿名 Token 用量统计（仅计数，不包含对话文本正文）</li>
          <li>客户端版本更新检查请求，确保功能及时更新</li>
          <li>仅在您显式导出时才生成本地诊断报告</li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.privacy-banner-card {
  padding: 16px 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.banner-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
}

.privacy-item-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.privacy-group-title {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

.privacy-bullet-list {
  margin: 0;
  padding-left: 20px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.7;
}
</style>
