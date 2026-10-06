# 航空发动机地面试车时序诊断与性能退化推演服务

纯后端 Node.js + TypeScript 工程，围绕航空发动机地面试车数据建立可追溯的时序诊断流程：遥测事件重放、传感器校准、工况分段、热力性能计算、振动证据融合、部件健康状态推进、故障根因推理和剩余寿命区间推演。

本项目只使用 Node.js 内置模块，不依赖 Docker、数据库、商业求解器或外部服务。项目是工程计算示例，不代表适航认证模型，正式使用前需要由有资质的工程团队校准物性、阈值和退化参数。

## 运行

```bash
npm test
npm start
```

服务默认监听 `127.0.0.1:4321`，可通过 `PORT` 修改端口。

## API

- `GET /health`
- `POST /v1/test-runs/analyze`：执行完整试车分析流程
- `POST /v1/timeline/replay`：按采样时间重放多通道遥测
- `POST /v1/performance/evaluate`：计算发动机热力性能快照
- `POST /v1/vibration/diagnose`：融合振动证据并输出故障候选
- `POST /v1/health/advance`：推进部件健康状态
- `POST /v1/root-cause/infer`：生成根因排序与解释链
- `POST /v1/life/estimate`：执行剩余寿命不确定性推演

### 综合分析的成败语义

`/v1/test-runs/analyze` 按依赖顺序推进八个阶段：回放 → 校准 → 分段 → 性能 → 振动 → 健康 → 根因 → 寿命（未提供 `life` 输入时跳过）。每个阶段在一次运行中只提交一次，失败不会触发重算或回填。

- 成功：HTTP 200，响应含 `status: "completed"` 与 `stages.completed` / `stages.skipped`，可逐项核对哪些阶段真实完成。
- 失败：HTTP 4xx/5xx，`error.code` 为 `ANALYSIS_STAGE_FAILED`，`error.details` 包含失败阶段 `stage`、已提交阶段 `completedStages`、原始错误 `cause`（保留领域错误码与明细）以及已完成阶段的上下文快照 `completedContext`（未提交的阶段为 `null`）。

每次调用都是独立运行：调用方修正输入后重试会从初始健康状态和原始遥测重新完整推进，不会叠加上一轮的部分结果。

## 目录

- `src/domain/timeline`：事件校验、确定性重放和时间线索引
- `src/domain/calibration`：校准版本选择、测量修正和不确定度传播
- `src/domain/phase`：慢车、加速、稳态、减速等试车工况识别
- `src/domain/performance`：参考状态、压比、修正转速和效率计算
- `src/domain/vibration`：振动窗口、相关证据去重和故障融合
- `src/domain/health`：压气机、涡轮、轴承和热端部件健康状态
- `src/domain/root-cause`：有向因果图和根因解释链
- `src/domain/life`：相关参数采样和剩余寿命统计
- `src/application`：完整试车分析用例编排
- `src/http`：基于 `node:http` 的 JSON API
