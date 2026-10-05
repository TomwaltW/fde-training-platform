# 标定集(方案 3.4.4)

每个子目录是一个标定用例:

```text
<caseId>/
  session.json            引擎的 SessionState(一局完整的对局)
  human.yaml              人工逐维度打分和理由(先标注,再跑裁判)
  judge-fixtures/*.json   可选:mock 模式下按文件名顺序当作裁判第 i 次的输出
  transcript.md           可选:可读的对话,方便标注,不参与计算
```

```bash
pnpm calibrate --init <session.json> --id <caseId>      # 建用例,生成待填的 human.yaml
pnpm calibrate --init-player EV_lazy --id script-EV_lazy
pnpm calibrate --live --record                          # 真裁判跑 3 次,并录下裁判输出
pnpm calibrate --mock                                   # 回放录好的裁判输出,不调模型
```

`example-EV_good`、`example-EV_rush` 是示例:对话由脚本化玩家离线跑出,human.yaml 是**示例标注,不是作者的真实标注**。正式标定前删掉。

完整说明见 [docs/calibration.md](../../../../docs/calibration.md)。
