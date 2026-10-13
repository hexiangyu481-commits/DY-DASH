# DY DASH

DY RaceLab Digital Instrument Simulator V0.1 — 面向 Honda Civic FD / R18A 的汽车数字仪表交互原型。

纯 HTML、CSS、JavaScript；无后端、无第三方运行依赖。不需要安装或构建，完整下载项目后，直接用浏览器打开根目录的 `index.html`。

## 运行与展示

- 在线演示：https://dy-dash.hexiangyu481.chatgpt.site
- 离线运行：保留 `index.html`、`style.css`、`script.js` 与 `assets/` 的相对位置，打开 `index.html`。
- 默认 16:9 展示；可切换到 800×480 对应的 5:3 硬件比例。800×480 不是 16:9。
- GitHub 仓库本身保存源码，不等同于已开通 GitHub Pages；在线演示独立托管。

## 仪表模式

| 模式 | 显示重点 |
| --- | --- |
| STREET 日常 | 环形转速表、RPM、速度、档位、水温、电压、进气温、油温 |
| TRACK 赛道 | 转速条、RPM、速度、WRC 风格大档位框；重点油压、油温，附节气门与进气温 |
| PROTECT 保护 | 油压、油温、水温及分级警告 |

控制区提供正常驾驶、激烈驾驶、油压下降、高油温、切换模式，以及暂停、重置、手动参数和全屏功能。

## 转速与换挡

- 超过 3500 rpm：转速数字与进度显示变红，属于视觉提示，不代表发动机故障。
- 达到 6500 rpm：换挡提示与全仪表反相闪烁；这是模拟器的提前换挡提示点。
- 6800 rpm：红线参考；7000 rpm 只是仪表量程上限，不代表已核实的 ECU 断油点。
- 转速、速度、档位按同一传动模型计算。升档包含收油与转速下降；降档包含 `REV MATCH` 补油阶段，转速匹配后才切换显示档位。
- 系统偏好“减少动态效果”时，强提示改为静态反相，避免持续闪烁。

传动参数暂用本田官方 2008 年美规 1.8L 的 5MT、终传 4.294 和 205/55 R16 轮胎作为参考。官方红线为 6800 rpm，最大功率转速 6300 rpm。国内车型的实际变速箱、轮胎及 ECU 断油点仍需分别核实；不能将这套参数视为用户实车标定。

参考资料：[Honda 2008 Civic Sedan Specifications](https://hondanews.com/en-US/releases/release-f7148944dc8b7f766d58ea004c34bdf7-2008-honda-civic-sedan-specifications)。

## 文件与结构

- `index.html`：仪表容器、模式入口与控制面板。
- `style.css`：仪表主题、比例适配、分级警告及换挡动画。
- `script.js`：配置 → 传动/场景模拟 → 警告规则 → 渲染 → 控制器。
- `assets/dy-racelab.png`：透明底 DY RaceLab Logo。
- `tests/transmission.cjs`：无额外依赖的传动与显示逻辑回归测试。
- `docs/EMBEDDED.md`：后续嵌入式适配边界。

代码中 `window.DYDash` 暴露模式、场景、手动数据、暂停、重置与状态读取接口。

## 验证

运行网页不需要 Node.js。开发者如需运行逻辑测试，可在项目根目录执行：

```sh
node --check script.js
node tests/transmission.cjs
```

本版本已通过 14 项传动/显示逻辑检查。测试使用 DOM 替身，不是浏览器视觉验收，也不是 STM32、OBD 或实车验证。

## 使用边界

此项目只提供演示数据，没有接入车辆、传感器或 STM32。20 Hz 是演示模型更新配置，不是实测 OBD 采样率。油压、油温、水温等阈值是原型展示配置，不是本田发动机保护标定，不应据此判断实车是否安全。

当前应用文件对应在线演示源码快照 `9fb395ed7b10c5ad6d60a4a43d3ffa0ab84f4aad`。
