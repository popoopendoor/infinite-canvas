# 前端开发指南

> 基于证据的约定，适用于 Vite React/TypeScript 客户端在 `web` 环境中。

## 指南索引

| 指南 | 范围 |
|---|---|
| [目录结构](./directory-structure.md) | 页、布局、组件、服务、钩子、商店和共享实用程序 |
| [组件指南](./component-guidelines.md) | 函数组件、props、Ant Design、样式、表单和 UI 语义 |
| [钩子指南](./hook-guidelines.md) | 自定义钩子、React Query、效果以及缓存失效 |
| [状态管理](./state-management.md) | React 本地状态、Zustand、React Query、路由和持久化 |
| [类型安全](./type-safety.md) | 严格的 TypeScript、所有权合同、运行时边界和缩小 |
| [质量指南](./quality-guidelines.md) | 可用的检查、当前的测试限制、可访问性和审查要点 |

## 包边界

这些指南描述 `web`，即浏览器客户端。它直接调用配置好的外部提供商以及本地 Canvas Agent；请不要假设前端功能可以依赖后端或数据库。
</translate_input>


 OAuth 后续推荐采用授权码模式：

 ```text
   网站浏览器
     -> 网站自己的后端或 BFF
     -> Flarum /oauth/authorize
     -> 网站 callback
     -> BFF 使用 client_secret 调用 /oauth/token
     -> BFF 调用 /api/user
     -> 网站通过 HttpOnly Cookie 保存登录会话
 ```

 client_secret 不能放进 Vite 前端代码或 VITE_* 环境变量中。Flarum 插件提供的主要接口是：

 ```text
   GET  /oauth/authorize
   POST /oauth/token
   GET  /api/user
 ```



 pi --session 01a071e1-b9ab-735a-804d-7a9a217013a1

 既然当前的 popoopendoor/infinite-canvas-main 可以放弃，最干净的方案是：重新对原项目执行真正的 GitHub Fork，然后把本地
 的 .codex 和 .trellis 复制过去。

 最终结构应该是：

 ```text
   原作者仓库：basketikun/infinite-canvas
           ↑ upstream，只读取更新

   你的 Fork：popo​​opendoor/infinite-canvas
           ↑ origin，你可以推送代码

   本地目录：infinite-canvas
 ```

 以后只记住：

 - origin = 你的仓库
 - upstream = 原作者仓库
 - main = 稳定分支
 - feature/... = 你开发功能的分支

 第一步：在 GitHub 创建真正的 Fork

 1. 打开原仓库：

    https://github.com/basketikun/infinite-canvas

 2. 点击右上角 Fork。

 3. Owner 选择你的账号 popoopendoor。

 4. 仓库名称保持默认的 infinite-canvas。

 5. 创建完成后，页面应该显示类似：

    ```text
      popoopendoor/infinite-canvas
      forked from basketikun/infinite-canvas
    ```

 不要通过 New repository 新建，这次必须点击原仓库页面上的 Fork。

 暂时不要删除旧的 popoopendoor/infinite-canvas-main，等新仓库确认可用后再删除。

 第二步：重新克隆你的 Fork

 下面命令适用于你当前使用的 WSL/Git Bash 环境。

 ```bash
   cd /mnt/c/Users/Harry/github
   mv infinite-canvas-main infinite-canvas-zip-backup
   git clone https://github.com/popoopendoor/infinite-canvas.git infinite-canvas
   cd infinite-canvas
 ```

 mv 只是把旧目录改名为备份，不会删除代码。

 如果你 Fork 后的仓库地址不是这个，请以 GitHub 页面显示的 Clone URL 为准。

 第三步：复制本地新增的两个目录

 ```bash
   cp -a ../infinite-canvas-zip-backup/.codex .
   cp -a ../infinite-canvas-zip-backup/.trellis .
 ```

 只复制你明确新增的目录，不要复制旧目录里的 .git。

 在提交前检查一下：

 ```bash
   git status --short
 ```

 确认 .codex 和 .trellis 中没有 API Key、Token、密码或其他私人信息。它们会进入公开的 GitHub Fork。

 第四步：配置两个远程仓库

 ```bash
   git remote add upstream https://github.com/basketikun/infinite-canvas.git
   git fetch upstream
   git remote -v
 ```

 你应该看到：

 ```text
   origin    https://github.com/popoopendoor/infinite-canvas.git
   upstream  https://github.com/basketikun/infinite-canvas.git
 ```

 其中：

 - 永远把自己的代码推送到 origin
 - 永远从原仓库读取更新：upstream

 第五步：提交 .codex 和 .trellis

 建议这次也使用一个独立分支和 Pull Request：

 ```bash
   git switch -c chore/add-local-workflow
   git add .codex .trellis
   git commit -m "chore: add local development workflow"
   git push -u origin chore/add-local-workflow
 ```

 然后打开你的 GitHub 仓库，创建 Pull Request：

 ```text
   base repository: popoopendoor/infinite-canvas
   base branch: main
   compare branch: chore/add-local-workflow
 ```

 合并这个 Pull Request。合并后，在本地执行：

 ```bash
   git switch main
   git pull --ff-only origin main
   git branch -d chore/add-local-workflow
 ```

 到这里就完成迁移了。

 以后同步原作者更新

 每次想同步原仓库时，只执行：

 ```bash
   cd /mnt/c/Users/Harry/github/infinite-canvas
   git switch main
   git fetch upstream
   git merge --no-edit upstream/main
   git push origin main
 ```

 原仓库的默认分支已经确认是 main，所以使用 upstream/main。

 如果显示：

 ```text
   Already up to date.
 ```

 说明目前没有新的原作者更新。

 如果出现冲突，不要继续执行其他命令，先查看：

 ```bash
   git status
 ```

 如果不知道应该保留哪一边，可以取消本次同步：

 ```bash
   git merge --abort
 ```

 以后新增功能

 先把 main 同步到最新，再创建功能分支：

 ```bash
   git switch main
   git pull --ff-only origin main
   git switch -c feature/add-export
 ```

 开发完成后：

 ```bash
   git add -A
   git commit -m "feat: add export feature"
   git push -u origin feature/add-export
 ```

 然后在 GitHub 创建 Pull Request，合并到 main。合并后清理本地分支：

 ```bash
   git switch main
   git pull --ff-only origin main
   git branch -d feature/add-export
 ```

 建议不要创建 develop、dev 等额外分支。你只需要：

 ```text
   main
   feature/某个功能
 ```

 建议的 GitHub 设置

 新 Fork 确认正常后，在 GitHub 的 Settings → Rules 或 Branch protection 中保护 main：

 - 禁止删除 main
 - 禁止强制推送
 - 要求通过 Pull Request 合并
 - 允许 Squash merge
 - 暂时不要要求 CI 检查，避免没有配置 CI 时把自己卡住

 这样你的日常流程就固定成：

 ```text
   同步 upstream
   → 从 main 创建 feature 分支
   → 开发
   → Pull Request
   → 合并
   → 删除功能分支
 ```

 确认新 Fork、.codex、.trellis 和本地新目录都正常后，再删除旧的 popoopendoor/infinite-canvas-main 仓库即可。