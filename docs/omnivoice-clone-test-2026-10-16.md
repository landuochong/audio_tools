# OmniVoice 本地音色克隆试听（2026-10-16）

## 目的与条件

对比声间现用的 Qwen3-TTS 与 VoiceStudio 默认模型 OmniVoice。VoiceStudio（原 OmniVoice-Studio）是多引擎工作台；本次直接用 `k2-fsa/OmniVoice` 模型做独立测试，当时尚未将它接入声间；下方记录后来选定的声音设计接入。使用本机 Apple Silicon、PyTorch/MPS、float16、原速 1.0，以及声间现有的 `data/reference/voice.wav` 与 `data/reference/transcript.txt`。参考音和测试音频只保留在本机 `data/`，不纳入 Git。

对照文字：

> 今天辛苦啦。先坐下来休息一会儿，不用急着把所有事情都做完。你想聊聊的话，我就在这里听你说。

## 实测结果

| 模型与设置 | 音频时长 | 整句生成耗时 | 本机试听文件 |
| --- | ---: | ---: | --- |
| OmniVoice，32 步 | 11.56 秒 | 15.48 秒 | `data/omnivoice-test/chat.wav` |
| OmniVoice，16 步 | 11.56 秒 | 9.30 秒 | `data/omnivoice-test/omnivoice-chat-16step.wav` |
| 声间 Qwen3-TTS，原始克隆 1.0× | 9.51 秒 | 8.99 秒 | `data/omnivoice-test/qwen3-chat-full.wav` |

另用 OmniVoice 32 步读原参考文本，生成 8.74 秒音频用时 19.98 秒，文件为 `data/omnivoice-test/reference-text.wav`。Qwen3-TTS 的整句对照通过现有 8031 服务的 `/synthesize` 接口生成。各数字均为单次测量，不含模型下载和加载时间，也不代表流式播放首声等待时间。首次下载并加载 OmniVoice 用时约 117 秒；权重已缓存后的再次加载约 2.81 秒。16 步是模型官方提供的较快参数，可能改变声音细节。

## 试听反馈与结论

用户认为 OmniVoice 的转换“听起来更舒服”，16 步版本“还可以”。同一文字中，Qwen3-TTS 原始输出较赶；仅将整段做 0.9×、0.75× 变速，仍未达到用户之前测试中的自然节奏。按短句重新生成、加入停顿后做放慢版仅供试听，未修改声间默认设置。Qwen3-TTS 旧试听读 30 个汉字用 8.68 秒，本次原始输出读 40 个汉字用 9.51 秒，说明不同文本下原始语速也会变化；不能仅靠时长判断温柔度和节奏。

当前优先候选为 OmniVoice 16 步，原因是用户更喜欢其听感，且这句的整句生成耗时与现用 Qwen3-TTS 接近。尚未测试 OmniVoice 在声间的分段或流式播放、首声等待、连续多句的稳定性及虚拟麦克风输出，因此不能据此认定它已满足实时聊天。接入前还应核对默认权重的使用许可。

## 复测信息

模型包 `omnivoice==0.2.1`；`torch==2.8.0`、`torchaudio==2.8.0`。测试环境位于 `experiments/omnivoice/.venv`，独立测试脚本为 `experiments/omnivoice/test_clone.py`。32 步测试参数为 `num_step=32, speed=1.0`；16 步只将 `num_step` 改为 16。两者都用相同参考音、准确文本和上述对照文字，输出 24 kHz WAV。更多原始数字保存在本机 `data/omnivoice-test/results.json`。

模型与运行方式参考：[OmniVoice 官方仓库](https://github.com/k2-fsa/OmniVoice)；[VoiceStudio 仓库](https://github.com/debpalash/VoiceStudio)。

## 声音设计预实验（同日）

声音设计不使用上述参考音，也不会保持现有克隆音色；本次用 OmniVoice 的 `instruct` 属性，16 步、原速生成新声音。试听文字与上方对照句含义相同，仅增加了句间标点。

| 设计属性 | 整句生成耗时 | 音频时长 | 本机试听文件 |
| --- | ---: | ---: | --- |
| `female, young adult, low pitch` | 3.65 秒 | 7.82 秒 | `data/omnivoice-test/design-female-low.wav` |
| `female, young adult, high pitch` | 3.42 秒 | 8.33 秒 | `data/omnivoice-test/design-female-high.wav` |
| `female, young adult, low pitch, whisper` | 4.06 秒 | 8.88 秒 | `data/omnivoice-test/design-female-whisper.wav` |

用音频帧自相关做粗略对照，低音与高音样本的可靠有声帧中位基频约为 255 Hz、369 Hz，说明音高属性对这批输出有明显影响；耳语不适合用同一方法评价。用户试听后选定「低音耳语」作为声间的可选声音。它与原始克隆音色并列，不使用参考音；整句生成完成后才开始播放，因此首声等待约等于整句生成时间，不能称为增量流式生成。官方声音设计属性只支持规定的性别、年龄、音高、耳语等标签，不能推断“温柔自然”等自由描述一定生效。见 [OmniVoice 声音设计说明](https://github.com/k2-fsa/OmniVoice/blob/main/docs/voice-design.md)。

## 接入状态

声间页面提供「原始克隆音色 / 低音耳语 · OmniVoice」二选一。文字、聊天建议和麦克风自动识别使用当前选中的声音；麦克风开始录音时固定本次声音，避免中途切换导致队列混音。OmniVoice 在独立的 8033 服务中按需加载，参数固定为 `female, young adult, low pitch, whisper`、16 步、原速。音频输出为 24 kHz PCM16/WAV；生成结束后经现有播放链路送到扬声器和/或虚拟麦克风。

## 保留克隆音色的耳语试验

收到“在原有音色基础上调成低音耳语”的需求后，用相同参考音、参考文本和上方对照文字，测试 OmniVoice 16 步、原速下同时提供 `ref_audio`/`ref_text` 与 `instruct`。这是克隆加风格提示，不等同于无参考音的声音设计。

| 提示 | 生成耗时 | 音频时长 | 本机文件 |
| --- | ---: | ---: | --- |
| `female, young adult, low pitch, whisper` | 12.54 秒 | 11.54 秒 | `data/omnivoice-test/clone-whisper.wav` |
| `whisper` | 8.78 秒 | 11.56 秒 | `data/omnivoice-test/clone-whisper-light.wav` |

两者均有效生成；与前面的原始 OmniVoice 克隆版音频时长接近。官方 [Tips & Notes](https://github.com/k2-fsa/OmniVoice/blob/master/docs/tips.md) 指出：参考音与风格提示冲突时，模型通常更偏向参考音。用户试听后认为两段都不合适，未接入声间。接口支持与音频时长都不能证明它做到了“仍像原音色，同时明显更低、更轻”。

## CosyVoice 3 参考音＋风格指令候选（同日）

用户试听后认为上方两段 OmniVoice「原音色＋耳语」都不合适，**未接入声间**。随后在隔离环境 `experiments/cosyvoice/.venv` 测试 [CosyVoice 3](https://github.com/QwenAudio/CosyVoice) 的参考音与风格指令组合；Mac 本地执行使用 [mlx-audio-plus](https://github.com/krmao/mlx-audio-plus) 的 MLX 移植与 `mlx-community/Fun-CosyVoice3-0.5B-2512-4bit` 权重，脚本为 `experiments/cosyvoice/test_style.py`。参考音与目标文字与前面相同。

| 模式 | 音频时长 | 生成耗时 | 本机文件 |
| --- | ---: | ---: | --- |
| 仅参考音克隆 | 11.32 秒 | 80.74 秒（含额外组件首次下载/初始化） | `data/omnivoice-test/cosyvoice3-clone.wav` |
| 参考音＋「请保持参考音色，用贴近耳边的轻柔耳语说话，音调略低，语速舒缓。」 | 9.76 秒 | 4.57 秒（模型热身后） | `data/omnivoice-test/cosyvoice3-whisper.wav` |

本地 SenseVoice 复识别确认两段均基本读出目标句，耳语版完整识别目标文字。生成耗时为单次测量，不能直接当作稳定延迟；首轮加载还用了约 90 秒，包含模型下载。用户试听后认为 CosyVoice 3「参考音＋低声耳语」仍不合适。当前声间没有接入 CosyVoice 3；停止仅靠普通参考音加耳语文字指令的试验。若继续追求原音色的自然耳语，优先取得同一说话人的低声/耳语参考片段及准确文本再做小范围试听。
