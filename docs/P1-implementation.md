# P1：共享规则、原版 AI 隔离与难度占位

P1 没有实现 V1 或 V2 策略。生产简单难度仅调用 `legacy-v1`。

## 架构与文件

- `js/rules.js`：独立规则核心。无 DOM、动画、存储、定时器或随机源依赖。
- `js/legacy-v1.js`：原版策略函数体原样保留，只将环境改为观察对象和显式随机状态；包括原来的评分、候选顺序、LCG、同色需求计算、归还偏好和贵族选择。
- `index.html`：保留 CSS、美术、牌表、界面及记录格式，行动适配器调用规则核心；AI 调度器只向策略传入观察和 RNG。
- `scripts/sync-inline.cjs`：将两个 JS 源文件原样嵌入 HTML。`npm test` 会先检查嵌入内容一致性。
- `scripts/browser-regression.cjs`：实际 Chromium/WebKit 回归、截图、导入导出和性能测量。
- `tests/rules-engine.test.cjs`：独立策略、模拟与旧版的对照，以及规则和隐私边界检查。
- `tests/p1-integration.test.cjs`：生产适配器、迁移、难度、调度、原布局和美术保护。
- `tests/helpers/game-harness.cjs`：支持多段内联脚本；测试桥接不进入生产页面。
- `tests/rules.test.cjs`：黄金 TODO 已转为正式测试。准备过程改为合法行动者及真实回合，原规则断言不变。
- `tests/compat.test.cjs`：允许三项追加元数据；原有游戏字段仍与冻结样例逐项比较。
- `package.json`、`package-lock.json`：测试命令；Playwright 1.64.0 仅为开发依赖。
- `.gitignore`：忽略 `node_modules`。

P0 的原版 HTML、冻结清单、155个决策预期、牌表、14份样例均未修改。

## 规则接口

```js
const rules = SplendorRules.create(CARD_POOL);
rules.legalActions(state, who);
rules.validateAction(state, action, who);
rules.executeAction(state, action, who);
rules.prepareSettlement(state, who);
rules.advanceTurn(state, who);
rules.simulate(state, action, { discardColors, nobleId });
rules.observe(state, who);
```

`executeAction` 在修改前检查行动者、终局、阶段、资源、颜色、牌源、牌面数据、费用和预留上限。
失败返回 `ok: false` 和空事件，不修改输入，不记录行动。成功修改规则状态并返回事件，页面适配器随后调用原记录及动画函数。

`simulate` 复制规则字段后调用同一执行、结算和回合逻辑。它不修改输入，也不接触记录、存档、页面或动画。
没有提供归还颜色或多贵族选择时，返回待完成阶段。真实玩家继续使用原来的逐枚归还及贵族选择弹窗。

`rulePhase` 区分 `action / settle / discard / noble / complete / over`，防止重复行动和同回合多领贵族。
存档恢复优先从结束状态及已有规则弹窗恢复阶段，兼容旧页面留下的阶段元数据。

模拟必须使用调用方构造的假设牌堆。当前策略没有接收真实规则状态或真实牌堆，P1 不实现未知牌采样或搜索。

## AI 信息边界与基线保护

观察对象只包含市场、银行、贵族、公开玩家资源与已购牌、自己的完整预留、对手公开预留、对手盲预留等级及牌堆数量。
不传入 `setup`、牌序指纹、牌堆内容、复盘、备注、存档或玩家的额外字段。数组和对象均复制，策略不能通过引用修改真实状态。

随机状态作为独立参数传入。策略返回行动及下一随机状态；实际行动通过核心校验后才更新 RNG。
归还筹码使用行动执行后重新构造的观察，保留原版根据新公开市场判断颜色价值的行为。

原版内部 `canTake` 函数体仍作为封存策略的一部分保留，且不对外导出；其候选仅枚举五种普通颜色。
所有生产资源变更必须经过新核心，不能通过旧策略函数直接取得黄金。

旧 AI 的无候选兜底仍保留。该差异已在实施中报告；核心不把 `pass` 作为合法行动。
合成案例只保护旧策略分支，不视为合法对局。有效案例全部检查资源、卡牌、分数、折扣和贵族守恒。

## 页面、存档与部署

新对局设置的难度行仅在 AI 模式显示：简单可选，普通和困难显示“尚未启用”并禁用。
程序接口拒绝启动未启用难度。若载入未启用难度的存档，明确提示使用简单，并保留对局进度。

存档仅追加 `aiDifficulty: 'easy'`、`aiVersion: 'legacy-v1'`、`rulePhase`。
旧存档缺少难度默认简单；不重洗牌，不清除卡牌、筹码、贵族、分数、随机状态或事件。
原 localStorage 键、卡牌 ID、牌序指纹、`splendor-board-seed-v1` 和复盘基本格式均保留。

对局重开会取消旧 AI 定时器；回调检查对局身份，避免旧任务在新局行动。
在 AI 回合关闭设置或牌序窗口会重新安排一次 AI 行动，避免对局停住。

HTML 不引用外部脚本或运行时网络服务，下载一份 `index.html` 即可本地运行。
GitHub Pages 继续直接服务静态 HTML；开发源文件不需要随 HTML 下载才能运行。
修改 JS 后运行 `npm run sync:inline`，再运行测试，保证发布的 HTML 与源文件一致。
本阶段没有发布到 GitHub Pages，项目子路径兼容通过本地静态服务验证。

## 复现测试

```sh
# 不安装依赖也可运行规则、兼容及基线测试，需 Node.js 22+
npm test
npm run test:legacy
npm run test:rules
npm run test:compat

# 开发浏览器回归；这些依赖不进入游戏运行时
npm ci
npx playwright install --with-deps chromium webkit
npm run test:browser
```

浏览器脚本默认在系统临时目录的 `splendor-p1-browser-report` 保存 JSON、导出样例和截图。
可用 `SPLENDOR_BROWSER_REPORT_DIR` 指定位置；`SPLENDOR_PLAYWRIGHT_MODULE` 可指定测试工具安装位置。

本次 WebKit 测试环境没有管理员认证：运行库解包到 `/tmp`，只为测试进程设置库和字体路径。
Playwright 的全局系统缓存扫描无法识别临时 GLES 库，因此跳过该扫描；实际浏览器启动及测试断言仍执行。
下载的 MiniBrowser 启动包装脚本追加原库路径，以加载临时运行库；浏览器二进制和游戏文件没有因此改变。

## 范围与限制

- 手机横竖屏使用真实 Linux 浏览器引擎的触摸、移动视口模式，不等于 iPhone Safari 真机测试。
- 性能数据属于测试宿主，不能据此承诺低端 iPhone 的实际耗时。
- 原人类盲预留复盘事件中的牌面信息仍按旧格式保留；AI 观察对象不读取该事件或整个复盘。
- 原版同色需求计数和无候选兜底未调优，以保护简单难度行为。
- 未开发 V1、V2、未知牌模型或搜索 Worker，未 commit/push/reset/stash。
