// 内置连接器的唯一聚合点：新增连接器时在这里增加一行静态导入。
import "./githubConnector.js";
import "./feishuConnector.js";
import "./wechatConnector.js";

export {
  CONNECTOR_REGISTRY,
  getConnectorDefinition,
  listConnectorDefinitions,
} from "./registryCore.js";
