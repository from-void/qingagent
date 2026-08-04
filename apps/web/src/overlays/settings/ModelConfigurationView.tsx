import { ArrowLeftIcon } from "../../system/icons";
import { SkinSelect } from "../../system/SkinSelect";
import { MODEL_DEFAULTS } from "./modelSettingsTypes";
import { vendorName } from "./modelVendorMeta";
import { SecretInput } from "./SecretInput";
import { maskKey } from "./visitorKeyStore";
import type { ModelSettingsController } from "./useModelSettingsPanel";

export function ModelConfigurationView({
  controller,
}: {
  controller: ModelSettingsController;
}) {
  const {
    configProvider, keyInput, setKeyInput, persisting,
    invalidatePersistence, invalidateKimiVerification, invalidateCustomTest,
    handleSave, handleVerifyKimiKey, verifyStatus, verifyMsg, checkBalance,
    balanceLoading, configProviderConfigured, keyFormatOk, officialFlash, setOfficialFlash,
    officialPro, setOfficialPro, setupMode, setSetupMode,
    customProtocol, setCustomProtocol, customBaseUrl, setCustomBaseUrl,
    customKey, setCustomKey, customModelFlash, setCustomModelFlash,
    customModelPro, setCustomModelPro, customBaseUrlValid, customTesting,
    handleSaveCustom, customProvider, visitorKey, serverProviderState,
    closeConfig, anyConfigured, handleClearVisitor, handleClearCustom, message,
  } = controller;
  const officialKeyForm = (
    <>
      <div className="sm-keyrow">
        <SecretInput
          autoComplete="off"
          spellCheck={false}
          className="sm-keyinput"
          placeholder={configProvider === "kimi" ? "粘贴 Kimi API key" : "粘贴 DeepSeek API key(sk-…)"}
          value={keyInput}
          disabled={persisting}
          onChange={(e) => {
            invalidatePersistence();
            invalidateKimiVerification();
            setKeyInput(e.target.value);
          }}
          data-wf="ModelKeyInput"
        />
        <button
          type="button"
          className="sm-btn"
          onClick={() => void handleSave()}
          disabled={persisting || !keyInput.trim()}
          title={!keyInput.trim() ? "请先填入 API key" : undefined}
        >
          保存
        </button>
        {configProvider === "kimi" ? (
          <button
            type="button"
            className="sm-btn"
            onClick={() => void handleVerifyKimiKey()}
            disabled={persisting || verifyStatus === "verifying" || !keyInput.trim()}
            title="发起 Kimi 请求"
            data-wf="KimiVerifyBtn"
          >
            {verifyStatus === "verifying" ? "测试中…" : "测试连接"}
          </button>
        ) : (
          /* DeepSeek:「重新检测」与「测试连接」合并成一个动作——
             填了新 key 就测新 key,没填就重测已保存的配置。 */
          <button
            type="button"
            className="sm-btn"
            onClick={() => void checkBalance(undefined, keyInput.trim() || undefined)}
            disabled={persisting || balanceLoading || (!keyInput.trim() && !configProviderConfigured)}
            title="查询 DeepSeek 连通性与余额"
            data-wf="BalanceCheckBtn"
          >
            {balanceLoading ? "检测中…" : "测试连接"}
          </button>
        )}
        <button
          type="button"
          className="sm-btn"
          onClick={closeConfig}
          disabled={persisting}
        >
          取消
        </button>
      </div>
      {keyFormatOk && verifyStatus === "verifying" && <p className="sm-verify sm-verify--ing">正在验证 key…</p>}
      {verifyStatus === "ok" && (
        <p className="sm-verify sm-verify--ok">
          <span className="md-dot md-dot--ok" aria-hidden="true" />
          {verifyMsg}
        </p>
      )}
      {verifyStatus === "fail" && (
        <p className="sm-verify sm-verify--fail">
          <span className="md-dot md-dot--bad" aria-hidden="true" />
          {verifyMsg}
        </p>
      )}
      {configProviderConfigured && configProvider === "deepseek" && (
        <div className="sm-model-prefix">
          <div className="sm-field">
            <span className="sm-field-label">V4 Flash 模型名（一般无需修改）</span>
            <input
              className="sm-field-input"
              placeholder="deepseek-v4-flash"
              value={officialFlash}
              disabled={persisting}
              onChange={(e) => {
                invalidatePersistence();
                setOfficialFlash(e.target.value);
              }}
            />
          </div>
          <div className="sm-field">
            <span className="sm-field-label">V4 PRO 模型名</span>
            <input
              className="sm-field-input"
              placeholder="deepseek-v4-pro"
              value={officialPro}
              disabled={persisting}
              onChange={(e) => {
                invalidatePersistence();
                setOfficialPro(e.target.value);
              }}
            />
          </div>
          <p className="sm-keyhint">留空即用官方默认模型名;仅当官方升级换名导致报错时才需要改。</p>
        </div>
      )}
      <p className="sm-keyhint">Key 只保存在本机，用于发起模型请求。</p>
    </>
  );

  // 配置编辑器(官方 / 其他厂商两 tab):二级页主体。
  // 未配置的厂商显示官方注册步骤;已配置的厂商改显示模型名前缀与清除入口。
  const configSection = (
    <div className="sm-config">
      <div className="sm-faq-q">
        {configProviderConfigured
          ? `切换 / 修改模型配置 · ${vendorName(configProvider)}`
          : `如何配置 ${vendorName(configProvider)}?`}
      </div>
      <div className="sm-setup-tabs" role="tablist" aria-label="配置方式">
        <button
          type="button"
          role="tab"
          aria-selected={setupMode === "official"}
          className={`sm-setup-tab${setupMode === "official" ? " sm-active" : ""}`}
          onClick={() => {
            invalidateCustomTest();
            setSetupMode("official");
          }}
          disabled={persisting}
        >
          <span>接入 {vendorName(configProvider)} 官方 API</span>
          <small>推荐方式（步骤简单）</small>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={setupMode === "other"}
          className={`sm-setup-tab${setupMode === "other" ? " sm-active" : ""}`}
          onClick={() => {
            invalidateCustomTest();
            setSetupMode("other");
          }}
          disabled={persisting}
        >
          <span>接入其他云厂商 / 模型</span>
          <small>进阶设置</small>
        </button>
      </div>

      {setupMode === "official" ? (
        <div className="sm-official">
          {!configProviderConfigured && (
            <ol className="sm-steps">
              <li>
                前往{" "}
                <a
                  href={configProvider === "kimi" ? "https://www.kimi.com/code" : "https://platform.deepseek.com/"}
                  target="_blank"
                  rel="noreferrer"
                >
                  {configProvider === "kimi" ? "Kimi Code" : "platform.deepseek.com"}
                </a>{" "}
                完成注册登录
              </li>
              <li>{configProvider === "kimi" ? "确认套餐已开通 K3 / K2.7 Code 权限" : "可先小额充值试用"}</li>
              <li>
                创建并复制 API key
              </li>
              <li>粘贴到下方输入框,点保存</li>
            </ol>
          )}
          {officialKeyForm}
        </div>
      ) : (
        <div className="sm-other">
          <p className="sm-other-note">
            接入任意兼容 OpenAI 协议的云厂商或自部署模型。<strong>进阶操作</strong>,不熟悉请用官方 API。
          </p>
          <div className="sm-field">
            <span className="sm-field-label">API 协议类型</span>
            <SkinSelect
              className="sm-field-select"
              value={configProvider === "kimi" ? "openai" : customProtocol}
              disabled={persisting || configProvider === "kimi"}
              ariaLabel="API 协议类型"
              skin="ink"
              options={[
                { value: "openai", label: "OpenAI 兼容" },
                ...(configProvider === "deepseek"
                  ? [{ value: "anthropic", label: "Anthropic 兼容" }]
                  : []),
              ]}
              onChange={(value) => {
                invalidateCustomTest();
                setCustomProtocol(value);
              }}
            />
          </div>
          <div className="sm-field">
            <span className="sm-field-label">API 地址(Base URL)</span>
            <input
              className={`sm-field-input${customBaseUrlValid === false ? " sm-field-input--invalid" : ""}`}
              placeholder="https://your-endpoint/v1"
              value={customBaseUrl}
              disabled={persisting}
              aria-invalid={customBaseUrlValid === false}
              aria-describedby={customBaseUrlValid === false ? "model-custom-base-url-error" : undefined}
              onChange={(e) => {
                invalidateCustomTest();
                setCustomBaseUrl(e.target.value);
              }}
            />
            {customBaseUrlValid === false && (
              <p className="sm-field-err" id="model-custom-base-url-error">
                请输入完整地址,需以 http(s):// 开头,如 https://your-endpoint/v1
              </p>
            )}
          </div>
          <div className="sm-field">
            <span className="sm-field-label">API key</span>
            <SecretInput
              autoComplete="off"
              spellCheck={false}
              className="sm-field-input"
              placeholder="sk-…"
              value={customKey}
              disabled={persisting}
              onChange={(e) => {
                invalidateCustomTest();
                setCustomKey(e.target.value);
              }}
            />
          </div>
          <div className="sm-field">
            <span className="sm-field-label">
              {configProvider === "kimi" ? "K2.7 Code（Flash）模型别名" : "V4 Flash 模型别名(可选)"}
            </span>
            <input
              className="sm-field-input"
              placeholder={MODEL_DEFAULTS[configProvider].flash}
              value={customModelFlash}
              disabled={persisting}
              onChange={(e) => {
                invalidateCustomTest();
                setCustomModelFlash(e.target.value);
              }}
            />
          </div>
          <div className="sm-field">
            <span className="sm-field-label">
              {configProvider === "kimi" ? "K3（Pro）模型别名" : "V4 PRO 模型别名(可选)"}
            </span>
            <input
              className="sm-field-input"
              placeholder={MODEL_DEFAULTS[configProvider].pro}
              value={customModelPro}
              disabled={persisting}
              onChange={(e) => {
                invalidateCustomTest();
                setCustomModelPro(e.target.value);
              }}
            />
          </div>
          <p className="sm-other-note">
            {configProvider === "kimi"
              ? "档位固定映射 Flash → kimi-for-coding、Pro → k3；第三方中转别名不同时可在上方修改。"
              : "默认适配 DeepSeek 模型。其他模型可在上面改成对应别名自行尝试(效果不保证);两者留空则默认用 deepseek-v4-flash。"}
          </p>
          <button
            type="button"
            className="sm-btn"
            onClick={() => void handleSaveCustom()}
            // baseURL 非法(非空但格式错)时 proactive 禁用,别等点击才报错——更早阻止无效提交(e2e #15增强)。
            // 空值仍可点(handleSaveCustom 给"请填写 API 地址"就近提示)。
            disabled={customTesting || persisting || customBaseUrlValid === false}
            aria-disabled={customTesting || persisting || customBaseUrlValid === false}
            title={customBaseUrlValid === false ? "需以 http(s):// 开头" : undefined}
          >
            {customTesting ? "测试中…" : "测试并保存"}
          </button>
        </div>
      )}
    </div>
  );

  // 二级页里的 key 概览:不再外露"本机 / 站点全局 / 环境变量"分层,统一「已配置密钥」语义。
  const keySourceLabel = customProvider ? "自定义模型" : "已配置密钥";
  const keySourceDetail = customProvider
    ? customProvider.baseUrl
    : visitorKey
      ? maskKey(visitorKey)
      : serverProviderState?.maskedTail
        ? `••••${serverProviderState.maskedTail}`
        : "";


  return (
        /* —— 二级配置页:同弹层内的视图切换,现「切换 / 修改模型配置」全套元素平移 —— */
        <section className="sm-setup vd-subpage" data-wf="ModelConfigPage">
          <div className="sm-guide">
            <button
              type="button"
              className="sm-back"
              onClick={closeConfig}
              disabled={persisting}
              data-wf="ModelConfigBack"
            >
              <ArrowLeftIcon size={13} />返回
            </button>
            {!anyConfigured && (
              <div className="sm-faq">
                <div className="sm-faq-item">
                  <div className="sm-faq-q">青简是什么?</div>
                  <p className="sm-faq-a">
                    青简是一款<strong>免费、开源</strong>的中文写作工具，能搜索资料、读取网页、解析文件，帮你完成各类文稿写作。
                  </p>
                </div>
                <div className="sm-faq-item">
                  <div className="sm-faq-q">数据会存储在哪里?</div>
                  <p className="sm-faq-a">
                    青简是<strong>本地软件</strong>，你的文档和对话数据保存在本机；使用模型或联网功能时，相关内容会发送给你配置的服务处理。
                  </p>
                </div>
                <div className="sm-faq-item">
                  <div className="sm-faq-q">如何收费?</div>
                  <p className="sm-faq-a">
                    青简<strong>本身不收基础费用</strong>；使用模型服务时，费用按模型服务商的账单计算。
                  </p>
                </div>
              </div>
            )}
            {configProviderConfigured && (
              <div className="vd-keyline">
                <span className="md-keysrc">
                  当前使用 <strong>{keySourceLabel}</strong>
                  {keySourceDetail ? (
                    <>
                      {" · "}
                      <span className="md-keysrc-detail font-mono" title={keySourceDetail}>
                        {keySourceDetail}
                      </span>
                    </>
                  ) : null}
                </span>
                <span className="md-keyops">
                  {visitorKey && (
                    <button
                      type="button"
                      className="md-mini-btn"
                      onClick={() => void handleClearVisitor()}
                      disabled={persisting}
                      data-wf="ModelClearKey"
                    >
                      清除密钥
                    </button>
                  )}
                  {customProvider && (
                    <button
                      type="button"
                      className="md-mini-btn"
                      onClick={() => void handleClearCustom()}
                      disabled={persisting}
                      data-wf="ModelClearCustom"
                    >
                      清除自定义配置
                    </button>
                  )}
                </span>
              </div>
            )}
            {configSection}
          </div>
          {message && <p className="sm-message">{message}</p>}
        </section>
  );
}
