# 协作工作流（双仓库）

## 0. 先弄清楚：本项目有两个仓库

| 角色         | 仓库                     | 地址                                          | 本地 remote | 权限                  |
| ------------ | ------------------------ | --------------------------------------------- | ----------- | --------------------- |
| **总仓库**   | `404-Wont-Fix/CloudHelm` | https://github.com/404-Wont-Fix/CloudHelm     | `upstream`  | **只读**，push 会 403 |
| **开发仓库** | `TianJiaJi/CloudHelm`    | https://github.com/TianJiaJi/CloudHelm        | `origin`    | 读写，日常 push 目标  |

- **日常开发在开发仓库**：提交到 `dev`，`git push` 推 `origin`
- **总仓库只吸收 PR**：开发仓库发起 PR → 合并到总仓库 `main`
- 开发账户对总仓库**没有写权限**，`git push upstream` 会在建连阶段直接 403（预期行为，不是配置错误）

> 换句话说：开发仓库是总仓库的一个**可自由提交的副本**，
> 总仓库则是那个**只读的稳定发布点**。

除 GitHub 自身的仓库权限外，本项目**没有设置任何额外限制**
（无分支保护、无 pre-push hook、无 `core.hooksPath`）。

## 1. 远端

| 远端       | 仓库                     | 用途                            |
| ---------- | ------------------------ | ------------------------------- |
| `origin`   | `TianJiaJi/CloudHelm`    | 开发仓库，日常 `push` / `fetch` |
| `upstream` | `404-Wont-Fix/CloudHelm` | 总仓库，**无写权限**，仅供拉取   |

```bash
git remote -v
```

## 2. 分支

| 分支   | 所在仓库 | 说明                           |
| ------ | -------- | ------------------------------ |
| `main` | 总仓库   | 稳定分支，跟踪 `upstream/main`  |
| `dev`  | 开发仓库 | 日常开发集成分支，跟踪 `origin/dev` |

## 3. 日常开发

```bash
git switch dev

# ... 编码 ...

git add -A
git commit -m "feat: xxx"
git push                     # 默认推 origin（老账户），无需额外操作
```

本地提交身份已固定在**仓库级配置**（不影响 global）：

```bash
git config --local user.name "TianJiaJi"
git config --local user.email "100060706+TianJiaJi@users.noreply.github.com"
```

## 4. 同步上游

```bash
git fetch upstream
git merge upstream/main      # 或 git reset --hard upstream/main
git push origin dev
```

若 `dev` 上没有本地未推送的提交，直接用重置更省事：

```bash
git fetch upstream && git reset --hard upstream/main && git push origin dev
```

## 5. 把开发仓库的改动送进总仓库（PR）

由于开发账户对总仓库**没有写权限**，只能用 PR 合并：

```bash
# 1) 用老账户发起 PR（--head 的 "TianJiaJi:" 前缀是跨 fork 的关键）
gh auth switch --user TianJiaJi
gh pr create --repo 404-Wont-Fix/CloudHelm \
  --base main --head TianJiaJi:dev \
  --title "feat: xxx"

# 2) 用新账户合并
gh auth switch --user 404-Wont-Fix
gh pr merge <编号> --repo 404-Wont-Fix/CloudHelm --squash

gh auth switch --user TianJiaJi
```

### squash 合并后必须重置 dev

squash 会把多个提交压成一个**新 commit**，此时 `dev` 与 `upstream/main` 内容相同但
commit 不同，无法快进：

```bash
git fetch upstream
git reset --hard upstream/main
git push --force-with-lease origin dev
```

`dev` 是镜像上游的分支，重置不会丢代码（内容已在 `upstream/main` 中）。
用 `--force-with-lease` 而非 `--force`，避免覆盖意外提交。

## 6. 身份与凭据

| 用途                  | 账户            | 操作                                     |
| --------------------- | --------------- | ---------------------------------------- |
| commit 署名           | `TianJiaJi`     | 已写入 `.git/config`，自动生效            |
| `git push` 到老账户   | `TianJiaJi`     | 仓库级 credential helper 自动取 token     |
| 创建 PR               | `TianJiaJi`     | `gh auth switch --user TianJiaJi`         |
| 合并 PR / 管理主仓库  | `404-Wont-Fix`  | `gh auth switch --user 404-Wont-Fix`      |

## 7. 已知限制与网络

**开发账户对总仓库无写权限** —— `git push upstream ...` 会在建连阶段直接 403：

```
remote: Permission to 404-Wont-Fix/CloudHelm.git denied to TianJiaJi.
```

如需真正的「直推总仓库」，把开发账户加为 collaborator 即可（一次性）：

```bash
gh auth switch --user 404-Wont-Fix
gh api -X PUT repos/404-Wont-Fix/CloudHelm/collaborators/TianJiaJi -f permission=push

# 老账户接受邀请
gh auth switch --user TianJiaJi
gh api user/repository_invitations --jq '.[] | "\(.id)  \(.repository.full_name)"'
gh api -X PATCH user/repository_invitations/<id>
```

**网络代理** —— 本仓库 `.git/config` 中配置了：

```bash
git config --local http.proxy http://127.0.0.1:6740
```

代理端口变化时需要同步修改，否则 `git push` / `fetch` 会连接超时。

**护栏现状** —— 无。分支保护已关闭，pre-push hook 已移除，`core.hooksPath` 未设置。
如需恢复，可参考 git 历史中的 commit `6a53e1e`（hook）与 `WORKFLOW.md` 早期版本。
