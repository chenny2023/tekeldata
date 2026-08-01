# 交接:Arkham 永久停用 → 自建储备扫描接管

**日期:** 2026-08-01 · **状态:** 已完成并上线验证 · **收件人:** tekel 工程师

---

## 背景

Arkham 已被运营者**永久停用**(portfolio 端点 402,不再续费)。
`arkham_chain_reserves` / `arkham_reserve_history` / `arkham_chain_volume` 全部冻结在
2026-07-30 的值,但**不报错**——日快照和公开储备页一直在无声地服务 3 天前的数字。对一个
主打"实时链上数据"的站点,这是最糟的失败模式。

接替者:自建余额扫描 **`wallet_chain_balances`**(`refreshBalances()` in `aggregate.ts`,
诊断口 `/api/diag/wallet-chain-reserves`)。它的品牌覆盖本来就比 Arkham 宽(ETH 105 家
vs Arkham 全部 38 个实体);缺的是每个地址的金额算全,不是地址覆盖。

## 今天已落地的 6 个提交

均已 `push origin master` + `railway up` + 线上验证。

| commit | 内容 |
|---|---|
| `f288fb4` | 原生币漏计 |
| `db18462` | 包装/挂钩币漏计 |
| `8d979c0` | `/api/diag/top-wallet-balances` 逐地址审计端点 |
| `a668848` | **归属错误修复(最重要)** |
| `7f59f66` | EOA/合约标注(`wallet_code_kind` + `collectors/codekind.ts`) |
| `6a8801c` | 分类器按金额优先 + 非 EVM 链不再误报缺口 |
| `3c597eb` | 储备数据源切到自建扫描(`chainreserves.ts`) |
| `1dccfcd` | 跨链扇出按链归属 |

### 两处漏计

1. **原生币** — 所有 EVM 余额读取只累加稳定币,全代码库没有一处 `eth_getBalance`,
   原生 ETH/BNB/POL/AVAX 一律记 $0。
2. **包装/挂钩币** — WETH、WBTC、WBNB、BTCB 同样记 $0。赌场把金库放在 WETH 而非 ETH,
   BNB 链上的比特币敞口是 BTCB。

## 最关键的发现:修漏计炸出了一个更大的既有错误

原生币计入后,**ETH 赌场储备的 73.7% 坐在合约地址上**,不是赌场热钱包。用
`eth_getCode` 客观判定:

| 地址 | 标签 | 金额 | 真实身份 |
|---|---|---|---|
| `0xafcd96e5…c5da` | Gemini | $585.7M | 合约,持 310,262 ETH,**交易所托管** |
| `0xd69b0089…0303` | Gemini | $66.5M | 合约,交易所托管 |
| `0x3416cf6c…527c6` | MonkeyTilt | $35.4M | 22kB 代码,持 USDC+USDT 零 ETH,**Uniswap V3 池** |

对照组:Stake、Rainbet 是 **EOA**,持仓构成(ETH + USDC + USDT)完全符合赌场热钱包
→ 说明测量本身没问题,错的是归属。

公开 `casino.reserves` 从 **$1,524M** 修正到 **$860M**。

**修法**(均为启动时幂等执行):
- Uniswap 池 → `INFRA_DENYLIST`(db.ts),沿用既有的启动停用机制
- Gemini → 新增的 `MISCATEGORIZED_ENTITIES` 改判为 `exchange` 而非停用。它是真实实体,
  只是不是赌场;保留才能继续做交易所流向分析。

## 第二个发现:BASE 缺口不是缺地址,是缺记账

赌场在各 EVM 链**复用同一个 0x 地址**,而扫描只写"地址所登记那条链"的余额。扇出
`evmChainsBalanceUsdByChain` 明明读了 ETH 地址在 BASE/ARB 上的余额,却把按链拆分
**求和后丢弃**。记录每一片后(零额外 RPC 成本,那些调用本来就在跑):

| 链 | 修复前 | 现在 |
|---|---|---|
| BNB Chain | $15.4M / 13 家 | **$57.3M / 101 家** |
| Polygon | $14.4M / 13 | **$33.7M / 101** |
| **Base** | **缺席** | **$12.5M / 105** |
| Arbitrum | $464K / 10 | **$4.9M / 102** |
| Avalanche | $558K / 13 | **$2.7M / 102** |
| 扫描合计 | $456M | **$537M** |

**独立印证**:BSC $57.3M 已超过 Arkham 当年的 $50.9M;Base $12.5M 对 Arkham 的 $13.4M。
两个完全不同的方法论逼近同一答案。

## ⚠️ 四个必须知道的坑

### 1. 包装币绝不能加进 `config.evmTokens` / `bscTokens`
索引器对这两个列表里的**每笔转账按面值当美元记**(`evm.ts` 的 `usd: amount // stablecoin 1:1`),
加了 WETH 会把一笔 2 WETH 的转账记成 $2,污染全站交易量。
仅余额资产走独立列表:`evmReserveTokens` / `bscReserveTokens` / `EvmChainCfg.reserveTokens`,
每项带 `prices.ts` 的计价资产键。
**新增任何代币前必须链上验 `symbol()` + `decimals()`** —— 这个检查抓到 Polygon 的包装
原生币在 MATIC 改名后 symbol 已变成 `WPOL`。

### 2. 储备上修不可回滚
`alerts.ts` 的 `evalReserveDrop` 按高水位线的**跌幅**触发。高水位已被抬高,回滚这次
修正会让每个钱包显示约 66% 的"储备暴跌"并**向订阅者群发误报告警**。
遇到问题请**修归属,不要撤测量**。

### 3. 读取端必须用 `EXISTS`
```sql
WHERE EXISTS (SELECT 1 FROM watchlist w WHERE w.address=b.address AND w.active=1 AND w.category='casino')
```
- 不能用 `(chain, address)` join —— 会丢掉扇出行,那些链没有 watchlist 条目
- 不能用只按 address 的 join —— 同一地址若登记在两条链上会**翻倍计数**

### 4. `tsc -b` 不检查 `server/src`
仓库 `tsconfig.json` 的 `include` 只有前端 `src`,**服务端代码从来没被类型检查过**。
- 部署前必跑 esbuild(只验解析,不验类型)
- 验类型需用仓库外的一次性 tsconfig 指向 `server/src/**/*.ts`
- 基线是 **42 个历史遗留 strict 错误**,判据是"与 `git stash` 后 HEAD 的错误数相同",**不是零**

## 合约标注的口径(已定)

**只标注,不过滤。** PowH3D、Fomo3D、Dicey、MetaWin、Gamdom 这些链上 dApp 的资金本来
就锁在合约里,一刀切排除会删掉**真实**储备。

目前 ETH 上合约持有 $15.6M / **6.0%**(修正前是 73.7%),全部是这类合法 dApp。
分类器(`collectors/codekind.ts`)按金额从大到小跑,独立于余额扫描——即使它挂了,
储备数字也不受影响。非 EVM 链(SOL/TRON/BTC)报 `null` 而非"未分类"。

## 尚未完成 —— 这块交给你

### 地址发现引擎随 Arkham 一起没了
原 `harvestOne`(entity → 热钱包 → watchlist)。现状:

- `dune.ts` **正常运行**(query id `7810326`,236 个地址 / 14 个品牌),但仅限 EVM,
  且 Dune 的 `labels.addresses` 里我们这些品牌**没有 base 的 institution 标签**
  ——上游缺口,不是我们的 bug
- watchlist 来源分布:`btc-cluster` 2034 / 人工种子 1006 / `dune` 236
- 也就是说**除 BTC 外,新增地址目前几乎只靠 Dune 和人工,覆盖面会停止增长**

候选路径:
1. 交易图扩展(与已知热钱包高频往来、排除交易所/DEX,可复用现成的 `isInfraDenied`)
2. 公开浏览器名称标签(Wayback 抓 etherscan 标题的路子此前验证可行)
3. 运营商自公布的 PoR 地址

需要设计的是**启发式选型 + 置信度标注口径**,不适合直接照搬。

### 链迁移数据页仍未解锁
`SEO_CONTENT_BACKLOG.md` 里那一项。`chain_reserve_history` 已改从自建扫描写入
(旧的 Arkham 冻结行已一次性清除,`sync_state` 上闩防止误删真实序列),但 21 天的累积
**从今天重新起算**。门槛 `/api/diag/chain-reserve-history` 目前 `days=1/21`。

---

## 相关诊断端点

| 端点 | 用途 |
|---|---|
| `/api/diag/wallet-chain-reserves` | 按链储备 + 合约持有占比 |
| `/api/diag/top-wallet-balances?chain=ETH&limit=20` | 逐地址明细,带合约标记 |
| `/api/diag/chain-reserve-history` | 链迁移页的累积门槛 |
| `/api/diag/coverage` | watchlist 来源/链分布 |
| `/api/diag/arkham-chain-reserves` | 保留作对照(已冻结) |

记忆条目:`arkham-retired-self-hosted-reserves`、`tsc-does-not-check-server`
