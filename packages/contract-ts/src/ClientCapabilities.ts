export interface ClientCapabilities {
  folderSources: {
    desktopLocal: {
      enabled: boolean;
    };
    browserFsAccess: {
      enabled: boolean;
    };
  };
  skills: {
    // 是否允许在本环境安装/删除技能(写技能目录)。桌面端放开、云端 web 锁死。
    // 前端据此决定是否显示「导入技能」入口与右键删除(列表/启停始终可用)。
    mutationEnabled: boolean;
  };
  connectors: {
    mutationEnabled: boolean;
    reasonCode:
      | null
      | "CONNECTORS_DISABLED"
      | "PUBLIC_DEPLOYMENT"
      | "SINGLE_USER_OPT_IN_REQUIRED"
      | "AUTH_TOKEN_REQUIRED";
  };
}
