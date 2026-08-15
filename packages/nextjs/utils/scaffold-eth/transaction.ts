import { Abi, TransactionReceipt, decodeEventLog } from "viem";

export const getFriendlyTransactionError = (error: unknown) => {
  const value = error as { shortMessage?: string; details?: string; message?: string };
  const message = value?.shortMessage || value?.details || value?.message || String(error);
  const lower = message.toLowerCase();

  if (lower.includes("requests limited") || lower.includes("rate limit") || lower.includes("429")) {
    return "RPC 请求过快，请稍等几秒后重试";
  }
  if (lower.includes("user rejected") || lower.includes("user denied")) return "已取消钱包签名或交易";
  if (lower.includes("insufficient funds")) return "钱包 MON 余额不足，无法支付金额或 Gas";
  if (lower.includes("wrong network") || lower.includes("chain mismatch"))
    return "钱包网络不正确，请切换到 Monad Testnet";
  if (lower.includes("failed to fetch") || lower.includes("network") || lower.includes("timeout")) {
    return "网络或 RPC 暂时不可用，请稍后重试";
  }
  return message.length > 180 ? `${message.slice(0, 177)}…` : message;
};

export const getReceiptEventArg = <T>(receipt: TransactionReceipt, abi: Abi, eventName: string, argName: string): T => {
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (decoded.eventName === eventName) {
        const args = decoded.args as unknown as Record<string, unknown>;
        if (argName in args) return args[argName] as T;
      }
    } catch {
      // Receipt may contain logs emitted by other contracts.
    }
  }
  throw new Error(`交易已确认，但未找到 ${eventName} 事件`);
};
