import React from "react";

/**
 * Site footer
 */
export const Footer = () => {
  return (
    <div className="min-h-0 py-5 px-1 mb-11 lg:mb-0">
      <div className="w-full">
        <ul className="menu menu-horizontal w-full">
          <div className="flex justify-center items-center gap-2 text-sm w-full opacity-70">
            <span>⚡ AgentPay Vault</span>
            <span>·</span>
            <span>Monad Blitz 北京 V2 · 2026</span>
            <span>·</span>
            <a
              href="https://github.com/zhongxiaomi06-sudo/agentpay-vault"
              target="_blank"
              rel="noreferrer"
              className="link"
            >
              GitHub
            </a>
            <span>·</span>
            <a href="https://testnet.monadexplorer.com" target="_blank" rel="noreferrer" className="link">
              Explorer
            </a>
          </div>
        </ul>
      </div>
    </div>
  );
};
