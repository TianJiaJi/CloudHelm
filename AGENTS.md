# AGENTS.md — CloudHelm Agent 工作须知

本文件由 Pi / 其他编码 Agent 在启动时自动加载。**动手前先读完本节。**

## 1. 最重要的一条：代码分布在两个仓库

| 角色         | 仓库                     | 本地 remote | 权限                     |
| ------------ | ------------------------ | ----------- | ------------------------ |
| **总仓库**   | `404-Wont-Fix/CloudHelm` | `upstream`  | **只读**，push 会 403    |
| **开发仓库** | `TianJiaJi/CloudHelm`    | `origin`    | 读写，日常 push 目标      |

**不要以为只有一个仓库。** 任何「推送代码」的操作都必须先确认目标：

```bash
git remote -v   # 确认 remote 指向
```

- 推送到 **`origin`（开发仓库）** → 正常，`git push` 即可
- 推送到 **`upstream`（总仓库）** → **会失败**（403），只能走 PR

## 2. 分支

| 分支   | 所在仓库 | 说明                                |
| ------ | -------- | ----------------------------------- |
| `dev`  | 开发仓库 | **日常工作分支**，提交推送到这里     |
| `main` | 总仓库   | 稳定分支，跟踪 `upstream/main`       |

## 3. 标准操作

### 提交代码

```bash
git switch dev
git add -A && git commit -m "feat: xxx"
git push                    # → origin（开发仓库）
```

提交身份已在仓库级配置固定，无需改动：

```bash
git config --local user.name    # TianJiaJi
git config --local user.email   # 100060706+TianJiaJi@users.noreply.github.com
```

### 同步总仓库的最新代码

```bash
git fetch upstream
git reset --hard upstream/main      # 或 git merge upstream/main
git push origin dev
```

### 把开发仓库的改动送进总仓库（PR）

```bash
gh auth switch --user TianJiaJi
gh pr create --repo 404-Wont-Fix/CloudHelm \
  --base main --head TianJiaJi:dev --title "xxx"

gh auth switch --user 404-Wont-Fix
gh pr merge <编号> --repo 404-Wont-Fix/CloudHelm --squash
gh auth switch --user TianJiaJi
```

### squash 合并后必须重置 dev

squash 会产生**新 commit**，`dev` 与 `upstream/main` 内容相同但无法快进：

```bash
git fetch upstream
git reset --hard upstream/main
git push --force-with-lease origin dev     # 用 --force-with-lease，不要 --force
```

## 4. 护栏现状：无

- 总仓库 `main` 分支保护：**已关闭**
- 本地 pre-push hook：**已移除**
- `core.hooksPath`：**未设置**

因此不会再有任何本地拦截。**风险由操作者自行判断** —— 尤其注意：
`main` 与 `dev` 现在都不受保护，`git push --force` 可以直接覆盖远端历史。

## 5. 环境注意事项

**网络代理**：本仓库 `.git/config` 中配置了

```bash
git config --local http.proxy   # http://127.0.0.1:6740
```

若 `git push` / `fetch` 连接超时，先检查代理端口是否变化。

**凭据**：仓库级 credential helper 会通过 `gh auth token --user TianJiaJi` 动态取 token，
所以在 `gh` 中切换活跃账户**不会**影响本仓库的 `git push` 身份。

## 6. 相关文档

- [README.md](./README.md) —— 双仓库结构速览
- [WORKFLOW.md](./WORKFLOW.md) —— 完整协作工作流
