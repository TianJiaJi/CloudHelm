import { createRoot } from 'react-dom/client';
import { MarkdownMessage } from '../../../apps/desktop/src/renderer/markdown-message.js';
import '../../../apps/desktop/src/renderer/global.css';
import './preview.css';

const longLine = 'a-very-long-single-line-path/'.repeat(12);
const hundredLines = Array.from({ length: 100 }, (_, index) => `step ${String(index + 1).padStart(3, '0')}: systemctl status service-${index}`).join('\n');
const text = [
  '# 部署结果总览',
  '**服务运行正常**，以下是验证结果。',
  '### 检查项',
  '- 容器已启动，并配置自动重启\n  - 健康检查返回 HTTP 200\n  - 日志无错误\n- 端口监听正常',
  '1. 读取配置\n2. 重载服务',
  '- [x] 已核对端口\n- [ ] 待核对磁盘配额',
  '#### 后续建议',
  '##### 参考',
  '###### 附注',
  '> 配置变更前已保存恢复副本。',
  '长链接：https://docs.example.test/very/long/path/that/should/wrap/instead/of/overflowing?query=1&locale=zh-CN',
  '| 验证项 | 结果 | 说明 |\n| --- | --- | --- |\n| 容器状态 | running | `docker ps` 已确认 |\n| 监听端口 | 8080 | 0.0.0.0:8080 |',
  '你可以用 `docker ps` 查看容器。',
  '```yaml\nservices:\n  web:\n    image: nginx:1.27\n    ports:\n      - "8080:80"\n```',
  '```bash\necho "最近日志"\ndocker logs --tail 50 demo-service\n```',
  '```json\n{ "status": "ok", "port": 8080 }\n```',
  '```ts\nconst port: number = 8080;\n```',
  '```diff\n- listen 80;\n+ listen 8080;\n```',
  '```not-a-language\nplain fallback text\n```',
  '```\nno language header\n```',
  `\`\`\`bash\n${hundredLines}\n\`\`\``,
  `\`\`\`bash\n${longLine}\n\`\`\``,
  '[访问服务](https://service.example.test/status)',
  '![部署示意图](https://images.example.test/private.png)',
  '[不可执行链接](javascript:alert%281%29)',
  '<img src="https://images.example.test/raw.png" onerror="window.markdownExecuted=true">',
  '<script>window.markdownExecuted=true</script>'
].join('\n\n');
createRoot(document.getElementById('root')!).render(<main className="preview-card"><header>CloudHelm · AI 助手</header><MarkdownMessage text={text} /></main>);
