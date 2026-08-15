// 🎭 UI 完整走查 v2：burner 自动连接 → 切 Monad 测试网 → 注资 → 五张卡 → /lens
// 用法：node scripts/ui-walkthrough.mjs [baseURL]
// 截图输出到 /tmp/uitest/
import { mkdirSync, readFileSync } from "fs";
import { chromium } from "playwright-core";
import { createPublicClient, createWalletClient, fallback, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

const BASE = process.argv[2] ?? "http://localhost:3001";
mkdirSync("/tmp/uitest", { recursive: true });

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const shot = n => page.screenshot({ path: `/tmp/uitest/${n}.png`, fullPage: true });
const log = t => console.log(`\x1b[36m▸ ${t}\x1b[0m`);
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", message => {
  if (message.type() === "error") errors.push(message.text());
});

log("打开 " + BASE);
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(8000);

// burner 已自动连接？没有就手动连
const hasConnect = await page.getByRole("button", { name: /connect wallet/i }).count();
if (hasConnect > 0) {
  log("手动连接 burner…");
  await page
    .getByRole("button", { name: /connect wallet/i })
    .first()
    .click();
  await page.waitForTimeout(2000);
  await page
    .getByText(/burner/i)
    .first()
    .click();
  await page.waitForTimeout(2500);
} else {
  log("burner 已自动连接 ✓");
}

// 取 burner 地址（wagmi v2 persist 把 Map 序列化为 {__type:"Map",value:[[k,v]]}）
const burnerState = await page.evaluate(() => {
  const store = JSON.parse(localStorage.getItem("wagmi.store") ?? "{}");
  const conns = store?.state?.connections;
  if (conns?.__type === "Map") {
    const first = conns.value?.[0]?.[1];
    return { address: first?.accounts?.[0] ?? null, chainId: first?.chainId ?? store?.state?.chainId };
  }
  return { address: null, chainId: null };
});
const burnerAddress = burnerState.address;
log(`burner 地址: ${burnerAddress} (chainId=${burnerState.chainId})`);
if (!burnerAddress) throw new Error("burner 连接失败");

// 没在 Monad 测试网才切
if (burnerState.chainId !== 10143) {
  const switchBtn = page.getByRole("button", { name: /switch network|switch to/i }).first();
  if (await switchBtn.count()) {
    log("切换网络…");
    await switchBtn.click();
    await page.waitForTimeout(1500);
    const monadOpt = page.getByText(/monad/i).first();
    if (await monadOpt.count()) {
      await monadOpt.click();
      await page.waitForTimeout(3000);
    }
  }
} else {
  log("已在 Monad 测试网 ✓ 无需切换");
}

// 注资 3 MON（测试网）
const env = readFileSync(new URL("../../hardhat/.env.agents", import.meta.url), "utf8");
const demo = privateKeyToAccount(env.match(/DEMO_WALLET_PK=(0x[0-9a-fA-F]+)/)[1]);
const rpcTransport = fallback([
  http("https://monad-testnet.drpc.org"),
  http("https://rpc.ankr.com/monad_testnet"),
  http("https://testnet-rpc.monad.xyz"),
]);
const pub = createPublicClient({ chain: monadTestnet, transport: rpcTransport });
const wallet = createWalletClient({
  account: demo,
  chain: monadTestnet,
  transport: rpcTransport,
});
const bal = await pub.getBalance({ address: burnerAddress });
if (bal < parseEther("1")) {
  const fundHash = await wallet.sendTransaction({ to: burnerAddress, value: parseEther("3") });
  await pub.waitForTransactionReceipt({ hash: fundHash });
  log("已注资 3 MON ✓");
} else {
  log("burner 余额充足 ✓");
}
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(9000);
await shot("00-home-connected");

const clickTx = async (name, waitMs = 30000) => {
  const btn = page.getByRole("button", { name }).first();
  if (!(await btn.count())) {
    log(`⚠️ 找不到按钮「${name}」，跳过`);
    return false;
  }
  await btn.waitFor({ state: "visible" });
  await btn.click({ timeout: 30000 });
  log(`点击「${name}」→ 等待确认…`);
  await page
    .waitForFunction(
      label =>
        [...document.querySelectorAll("button")].some(node => node.textContent?.includes(label) && node.disabled),
      name,
      { timeout: 3000 },
    )
    .catch(() => undefined);
  await page.waitForFunction(
    label => {
      const button = [...document.querySelectorAll("button")].find(node => node.textContent?.includes(label));
      return !button || !button.disabled;
    },
    name,
    { timeout: waitMs },
  );
  const body = await page.locator("body").innerText();
  const failure = body.match(
    /RPC 请求过快|余额不足|网络或 RPC 暂时不可用|交易失败|开通道失败|结算失败|交易已确认，但未找到|ContractFunctionExecutionError/,
  );
  if (failure) throw new Error(`点击「${name}」失败：${failure[0]}`);
  return true;
};

// ---- 流支付 ----
log("第一幕：流支付");
await clickTx("开启金库");
await shot("01-stream-opened");
await page.waitForTimeout(5000);
await shot("02-stream-flowing");
await clickTx("服务商提现");
await shot("03-stream-withdrawn");

// ---- 按次 meter ----
log("第二幕：meter 按次计量");
await clickTx("挂单 0.0001 MON/次");
await clickTx("订阅");
await clickTx("签名并计量", 30000);
await clickTx("签名并计量", 30000);
await page.getByText(/付费数据：agent/).waitFor({ state: "visible", timeout: 10000 });
await shot("04-meter");

// ---- 通道 ----
log("第三幕：voucher 通道");
await clickTx("开启通道");
for (let i = 0; i < 3; i++) {
  await page
    .getByRole("button", { name: /调一次 API/ })
    .first()
    .click();
  await page.waitForTimeout(2500);
}
await shot("05-channel-signed");
await clickTx("服务商拿最后一张 voucher 结算", 15000); // 精确名，避免误中「关闭结算」
await shot("06-channel-settled");
// 链上核验结算真的发生了（nonce 动态读取，通道总是最新那个）
{
  const { keccak256, encodeAbiParameters, formatEther, parseAbi } = await import("viem");
  const CV = "0x36b45aea8267b0efb232a3a2515240a5c5178523";
  const cvAbi = parseAbi([
    "function channelNonce() view returns (uint256)",
    "function channels(bytes32) view returns (address,address,uint256,uint256,uint256,bool)",
  ]);
  const nonce = await pub.readContract({ address: CV, abi: cvAbi, functionName: "channelNonce" });
  const chId = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }],
      [burnerAddress, burnerAddress, nonce],
    ),
  );
  const ch = await pub.readContract({ address: CV, abi: cvAbi, functionName: "channels", args: [chId] });
  log(`链上核验：通道 settled = ${formatEther(ch[4])} MON ${ch[4] > 0n ? "✅" : "❌ 结算未上链"}`);
}

// ---- 乐观托管 ----
log("第四幕：乐观托管");
await clickTx("锁定资金");
await page.getByRole("button", { name: "服务商提交交付" }).waitFor({ state: "visible", timeout: 15000 });
await clickTx("服务商提交交付");
await shot("07-escrow-delivered");
log("等待争议窗口 65 秒…");
await page.waitForTimeout(65000);
await clickTx("乐观取款");
await shot("08-escrow-claimed");

// ---- P256 ----
log("第五幕：P256 验签");
await clickTx("模拟 agent 密钥签名", 8000);
await shot("09-p256");

// ---- /lens ----
log("第六幕：/lens 并行动画");
await page.goto(BASE + "/lens", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
await clickTx("并行执行这一批交易", 10000);
await shot("10-lens-parallel");
await page.waitForTimeout(6000);
await shot("11-lens-final");

log("✅ 走查完毕 → /tmp/uitest/");
if (errors.length) {
  console.log("\n⚠️ 页面报错:");
  errors.slice(0, 5).forEach(e => console.log("  " + e.slice(0, 300)));
} else {
  console.log("\n✅ 全程零 pageerror");
}
await browser.close();
