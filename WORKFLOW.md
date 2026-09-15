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
git merge --ff-only upstream/main   # merge commit 合并方式：可直接快进
git push origin dev
```

> **squash / rebase 合并后必读**
>
> 主仓库会把你的多个提交压成一个**新的 commit**，此时 `dev` 与 `upstream/main`
> 内容相同但 commit 不同，无法快进。需要把 `dev` 重置到上游：
>
> ```bash
git switch dev
git fetch upstream
git reset --hard upstream/main
git push --force-with-lease origin dev
> ```
>
> `dev` 是**镜像上游**的长青分支，重置它不会丢失代码（内容已在 `upstream/main` 中）。
> 使用 `--force-with-lease` 而非 `--force`，防止覆盖别人的提交。

## 5. 仓库护栏

本仓库的护栏分两层，**当前只保留客户端一层**。

> **当前策略：低摩擦优先（个人使用）。**
> 服务端分支保护已**关闭**，主仓库 `main` 可被直接推送。
> 即便关闭保护，本地 pre-push hook 仍会拦截向 `upstream` / `main` 的推送（可用 `ALLOW_PROTECTED_PUSH=1` 绕过）。
> 需要恢复保护时见 §5.1。

### 5.1 服务端：分支保护（当前已关闭）

> ⚠️ **状态：已关闭** —— `main` 当前可被直接推送。
> 关闭原因：个人使用场景下，强制 PR 的流程摩擦大于收益。

查看当前状态：

```bash
gh api repos/404-Wont-Fix/CloudHelm/branches/main --jq .protected   # true = 保护已开启
```

**重新开启完整保护**（建议在开始多人协作前执行）：

```bash
gh api -X PUT repos/404-Wont-Fix/CloudHelm/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": null,
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 0
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
```

开启后生效的规则：

| 规则                   | 值  | 效果                                      |
| ---------------------- | --- | ----------------------------------------- |
| Require a PR           | 开  | 禁止向 `main` 直推，只能走 PR              |
| Required approvals     | 0   | 不阻塞单人双账户流程；可按需调成 1         |
| Dismiss stale reviews  | 开  | 新提交会作废旧 approval                    |
| Require linear history | 开  | 只允许 squash / rebase 合并，历史保持线性  |
| Allow force pushes     | 关  | 禁止对 `main` 强推                         |
| Allow deletions        | 关  | 禁止删除 `main`                            |
| Enforce for admins     | 开  | 管理员同样受约束，包括新账户自己           |

如需「必须 1 人 approve」（由新账户审阅老账户的 PR）：

```bash
gh api -X PATCH repos/404-Wont-Fix/CloudHelm/branches/main/protection/required_pull_request_reviews \
  -f required_approving_review_count=1
```

#### 与保护无关的硬约束：老账户无写权限

老账户 `TianJiaJi` 对主仓库**只有读权限**，所以即便保护已关闭，`git push upstream ...`
仍会在建连阶段直接 `403 Permission denied`。

如需真正的「直推主仓库」能力，先把老账户加为 collaborator（`push` = 写权限）：

```bash
# 1) 新账户发出邀请
gh api -X PUT repos/404-Wont-Fix/CloudHelm/collaborators/TianJiaJi -f permission=push

# 2) 老账户接受邀请（邀请 id 从 /user/repository_invitations 取）
gh auth switch --user TianJiaJi
gh api user/repository_invitations --jq '.[] | "\(.id)  \(.repository.full_name)"'
gh api -X PATCH user/repository_invitations/<id>
```

加入后需同步放开 hook 的规则 1（否则仍会被本地拦截）：

```bash
ALLOW_PROTECTED_PUSH=1 git push upstream dev
```

或者直接编辑 `.githooks/pre-push` 删掉「规则 1：upstream 只读」那一段。

### 5.2 客户端：pre-push hook

`.githooks/pre-push` 在本地拦截两类高危推送，报错信息为中文并给出修复建议：

1. 向 `upstream`（新账户主仓库）推送任何分支
2. 向任意远端直接推送 `main` / `master`，或删除它们

> 服务端护栏只保护主仓库，**客户端 hook 才会拦住你往 fork 上推 `main`** —— 两层互补。

克隆后需执行一次（`core.hooksPath` 是本地配置，不随 clone 分发）：

```bash
sh scripts/install-hooks.sh              # Linux / macOS / Git Bash
pwsh -File scripts/install-hooks.ps1     # Windows PowerShell
```

应急绕过（会打印警告后放行）：

```bash
ALLOW_PROTECTED_PUSH=1 git push origin main
```

### 5.3 常见误操作与报错对照

> ⚠ Git 是在**与远端建连成功之后**才运行 pre-push hook 的。
> 因此「连不上 / 无写权限」类错误会先于 hook 报出，这是 Git 的固有行为，不是配置错误。

| 误操作 | 实际报错 | 说明 | 正确做法 |
| ------ | -------- | ---- | -------- |
| 在 `main` 上 `git push origin main` | `✗ CloudHelm pre-push 护栏已拦截本次推送` | hook 正常拦截，并给出中文修复建议 | `git switch dev` 后再推 |
| 在 `main` 上直接 `git push`（跟踪的是 `upstream/main`） | `Permission to 404-Wont-Fix/CloudHelm.git denied to TianJiaJi` (403) | 老账户对主仓库只有读权限，**建连阶段就被拒** | 这是预期行为，**不要绕过** |
| `git push upstream dev` | 同上 403 | `upstream` 只用于 `fetch` | `git push origin dev` |
| `git push origin dev` | — | 正常开发路径 | ✅ |

## 6. 身份与凭据速查

| 用途                     | 账户            | 命令                                    |
| ------------------------ | --------------- | --------------------------------------- |
| commit 署名（本仓库）    | `TianJiaJi`     | 已写入 `.git/config` 本地配置            |
| push 到 fork             | `TianJiaJi`     | 由 `origin` 远端 + 凭据管理器自动匹配    |
| 创建 PR                  | `TianJiaJi`     | `gh auth switch --user TianJiaJi`        |
| 合并 PR / 管理主仓库     | `404-Wont-Fix`  | `gh auth switch --user 404-Wont-Fix`     |

> 两个账号的凭据都通过 `gh auth login` 存放在系统凭据管理器（keyring）中，无需手工输入 token。

## 7. 红线约定

1. **不建议** `git push upstream` —— 老账户无写权限，会被 403 拒绝（本地 hook 也会提前拦截）。
2. **不建议** 在老账户 fork 上直接推 `main`，开发走 `dev`（本地 hook 会拦截 `main`）。
3. **不建议** 反向 PR（新账户 → 老账户）。
4. **禁止** 提交任何密钥、`.env` 文件（见 `.gitignore` 已配置的规则）。
5. PR 合并后及时同步 `dev`（§4.2），避免与 `upstream/main` 分叉过久。

需要临时突破护栏时，务必在 commit message 或 PR 描述里写清原因与回滚方式。
