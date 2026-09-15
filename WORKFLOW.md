# 协作工作流（双账户模型）

本仓库采用**双 GitHub 账户 + Fork PR** 的协作模型：新账户持有主仓库，老账户负责开发并向上游提 PR。

## 1. 角色与远端

| 角色         | GitHub 账户     | 仓库                            | 本仓库远端名 | 权限                       |
| ------------ | --------------- | ------------------------------- | ------------ | -------------------------- |
| **主仓库**   | `404-Wont-Fix`  | `404-Wont-Fix/CloudHelm`        | `upstream`   | 只读（仅接受 PR 合入）     |
| **开发 fork**| `TianJiaJi`     | `TianJiaJi/CloudHelm`           | `origin`     | 读写（日常推送目标）       |

关键点：**`origin` 指向老账户的 fork，`upstream` 指向新账户的主仓库。**

这样做的目的是让 `git push` / `git pull` 的默认行为就是「推送到老账户」，符合「先推老账户、再 PR 到新账户」的流程，避免误推主仓库。

查看当前远端配置：

```bash
git remote -v
```

预期输出：

```
origin    https://github.com/TianJiaJi/CloudHelm.git (fetch)
origin    https://github.com/TianJiaJi/CloudHelm.git (push)
upstream  https://github.com/404-Wont-Fix/CloudHelm.git (fetch)
upstream  https://github.com/404-Wont-Fix/CloudHelm.git (push)
```

## 2. 分支模型

| 分支           | 存放位置            | 说明                                          |
| -------------- | ------------------- | --------------------------------------------- |
| `main`         | `upstream`（新账户）| 稳定分支。**禁止直接 push**，只能通过 PR 合入 |
| `dev`          | `origin`（老账户）  | 长期开发集成分支，日常开发提交推送到这里      |
| `feature/<名>` | `origin`（老账户）  | 可选。功能隔离开发，完成后合入 `dev`          |

分支流向（单向，永不反向）：

```
feature/*  ──┐
             ├──►  origin/dev (老账户)  ──PR──►  upstream/main (新账户)
直接提交   ──┘
```

## 3. 日常开发流程

### 3.1 开始开发前，同步上游

```bash
git switch dev
git fetch upstream
git merge upstream/main        # 或 git rebase upstream/main
git push origin dev
```

### 3.2 开发并提交

提交身份已**固定在仓库本地配置**（不污染 global 配置）：

```bash
git config --local user.name "TianJiaJi"
git config --local user.email "100060706+TianJiaJi@users.noreply.github.com"
```

直接提交到 `dev`，或从 `dev` 切出功能分支：

```bash
git switch -c feature/xxx dev
# ... 编码 ...
git add -A
git commit -m "feat: 说明"
git push -u origin feature/xxx
```

### 3.3 推送到老账户

```bash
git push origin dev
```

> 因为 `origin` 就是老账户 fork，**普通 `git push` 即可**，不会碰到主仓库。

## 4. 发起 PR（老账户 → 新账户）

PR 必须由**老账户 `TianJiaJi`** 作为发起方提交，因此 gh CLI 的当前激活账号必须是 `TianJiaJi`。

```bash
# 确认激活账号（应为 TianJiaJi）
gh auth status

# 如不是，切换过去
gh auth switch --user TianJiaJi
```

### 方式一：gh CLI 创建

```bash
# 确保 head 分支已推送
git push origin dev

gh pr create \
  --repo 404-Wont-Fix/CloudHelm \
  --base main \
  --head TianJiaJi:dev \
  --title "feat: xxx" \
  --body "变更说明"
```

`--head` 中的 `TianJiaJi:` 前缀是跨 fork 发 PR 的关键，它显式指定来源 fork 的 owner。

### 方式二：网页创建

访问：<https://github.com/404-Wont-Fix/CloudHelm/compare/main...TianJiaJi:dev>

### 4.1 查看与合并 PR

```bash
gh pr list   --repo 404-Wont-Fix/CloudHelm
gh pr view   <编号> --repo 404-Wont-Fix/CloudHelm
gh pr diff   <编号> --repo 404-Wont-Fix/CloudHelm
gh pr checks <编号> --repo 404-Wont-Fix/CloudHelm
```

合并在主仓库侧完成（需要 `404-Wont-Fix` 权限）：

```bash
# 切到新账户身份合并
gh auth switch --user 404-Wont-Fix
gh pr merge <编号> --repo 404-Wont-Fix/CloudHelm --squash --delete-branch
gh auth switch --user TianJiaJi
```

### 4.2 PR 合并后同步

```bash
git switch dev
git fetch upstream
git merge upstream/main
git push origin dev
```

## 5. 身份与凭据速查

| 用途                     | 账户            | 命令                                    |
| ------------------------ | --------------- | --------------------------------------- |
| commit 署名（本仓库）    | `TianJiaJi`     | 已写入 `.git/config` 本地配置            |
| push 到 fork             | `TianJiaJi`     | 由 `origin` 远端 + 凭据管理器自动匹配    |
| 创建 PR                  | `TianJiaJi`     | `gh auth switch --user TianJiaJi`        |
| 合并 PR / 管理主仓库     | `404-Wont-Fix`  | `gh auth switch --user 404-Wont-Fix`     |

> 两个账号的凭据都通过 `gh auth login` 存放在系统凭据管理器（keyring）中，无需手工输入 token。

## 6. 红线约定

1. **禁止** `git push upstream main` —— 主仓库 `main` 只接受 PR。
2. **禁止** 在老账户 fork 上开 `main` 分支做开发，开发一律走 `dev`。
3. **禁止** 反向 PR（新账户 → 老账户）。
4. **禁止** 提交任何密钥、`.env` 文件（见 `.gitignore` 已配置的规则）。
5. `dev` 与 `upstream/main` 的分叉不要超过一个迭代周期，及时同步减少冲突。
