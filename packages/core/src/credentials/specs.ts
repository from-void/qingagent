/** 平台凭据规格:声明每个平台需要哪些 env 键(供前端设置页渲染表单、校验)。 */
export interface PlatformCredentialSpec {
  platform: string;
  label: string;
  /** 各 env 键的元信息。 */
  fields: Array<{ key: string; label: string; secret: boolean; placeholder?: string }>;
  /** 申请凭据的指引链接。 */
  helpUrl: string;
}

export const PLATFORM_CREDENTIAL_SPECS: PlatformCredentialSpec[] = [
  {
    platform: "dingtalk",
    label: "钉钉",
    fields: [
      { key: "DINGTALK_APP_KEY", label: "AppKey", secret: false },
      { key: "DINGTALK_APP_SECRET", label: "AppSecret", secret: true },
    ],
    helpUrl: "https://open-dev.dingtalk.com",
  },
];
