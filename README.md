# 桌面资料迁移收件柜

这个服务保存迁移条目的人工收件、历史版本和原始依据。重复提交相同业务内容与依据返回原收件；内容变化形成历史版本，原始字节用内容摘要回查。合作来源运行在本机，具体交互见 `docs/source-contract.md`。自动来源接入见下文「自动来源接入」。

## 运行环境

需要 Node.js 22.22.1 至 22.x，使用内置模块，没有第三方依赖。依赖锁文件随代码保存；`npm ci --offline --ignore-scripts --no-audit --no-fund` 不会下载包。数据目录默认是 `var`，可用 `DATA_DIR` 指定；不可让两个进程同时写同一目录。来源和收件服务默认只监听回环地址，不使用真实机构账号或外网数据。

## 开发与运行

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run demo
```

`npm start` 启动收件服务，默认端口4310；另一终端用 `npm run source` 启动来源端，默认端口4311。可分别通过 `PORT`、`SOURCE_PORT` 修改端口。测试和演示使用系统分配的端口，结束时关闭服务并删除临时收件数据，不需要固定等待时间。

## 已有收件接口

`GET /health` 查看状态；`POST /api/manual` 接收 `record` 和 `evidence`。业务内容需要 `archiveEntryId, archiveId, objects`，其中 `archiveEntryId` 是已有人工收件标识。每份依据包含来源 `source`、原始字节 `bytesBase64`，可选 `mediaType` 和需要核对的 `sha256`。`GET /api/records` 返回当前版本，`GET /api/history?key=...` 返回单个业务标识的历史，`GET /api/evidence/摘要` 返回原始字节。人工入口不推断自动采集是否完整；新增来源接入可以扩展领域状态，但应保留这些已用接口。

`fixtures/manual.json` 是可用的人工收件样例。`npm run demo` 实际启动两个本地服务，执行人工提交、重复收件、自动来源采集、结构化内容回查和原始依据回查；全程只用本机来源，不用外部网络。

## 自动来源接入

`POST /api/collect` 从本机合作来源采集导出件并写入收件。请求体为JSON对象：`source` 是来源基址（默认 `http://127.0.0.1:4311`，只接受本机回环地址），`export` 是导出件编号（默认 `17`）。收件端先取元数据，核对实际字节的长度与SHA256，不符则拒绝（422）且不写收件；核对通过后按 `docs/source-contract.md` 解析 binary plist 与 NSKeyedArchiver 对象图，结构化结果存为收件（业务标识 `export-编号`），原始字节存为依据，可用既有接口回查。采集只构造无行为的普通结构，不实例化来源类、不执行其方法。

归档值的结构化表示：字符串、普通整数、布尔值保持JSON原样；UID引用写作 `{"$ref": 序号}`（UID 0 按空值约定写作 null）；超出安全范围的整数写作 `{"$bigint": "十进制"}`；日期写作 `{"$date": "ISO时间"}`；数据块写作 `{"$data": "base64"}`。`objects` 逐项保留 `uid`（$objects 序号）、`physical`（物理对象表位置）与 `className`（来源类名，未识别为 null），共享引用与循环引用都经 `$ref` 回到原始归档对象。`projection` 只抽取 ArchiveEntry 条目与 ArchiveAsset 资源，其他类原样留在 `objects` 中供复核。

响应 `intake.status` 表示完整性：`complete` 表示全部对象解码且无问题；`partial` 表示存在损坏对象、引用越界或支持范围之外的类型，`intake.problems` 逐条说明；`failed` 表示文件级损坏，未解出任何对象。状态不是 `complete` 时不能视为整个导出件已迁移完整。

## 容器

```sh
docker build -t desktop-archives-intake .
docker run --rm --network none desktop-archives-intake npm test
docker run --rm --network none desktop-archives-intake npm run demo
```

镜像内容由 Dockerfile 的 SHA256 摘要固定；Node.js 22 主版本标签与 package.json 的 >=22.22.1 <23 兼容范围对应，验证环境可使用该范围内的补丁版本。构建需要本地已有该基础镜像；正式运行、测试和演示不安装系统包、不下载模型或数据。服务默认数据放在容器内临时目录，持久运行时可挂载单独卷。演示完整输出可在90秒内展示，不播放预先保存的日志。
