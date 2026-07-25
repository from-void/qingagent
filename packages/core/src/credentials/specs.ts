/** 平台凭据规格:表单型 secret 与 connector namespace 分开登记；值只入不出。 */
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
    platform: "connector:wechat-mp",
    label: "微信公众号",
    fields: [
      { key: "bundle", label: "扫码会话凭据", secret: true },
    ],
    helpUrl: "https://mp.weixin.qq.com/",
  },
];
