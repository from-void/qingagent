
/**
 * 取消当前生成。
 *
 * 已收到 start 帧时用 streamId 做定向取消；start 帧到达前的规划准备期还没有
 * streamId，此时必须允许按 sessionId 取消。运行时 schema 会保证二者至少存在一个。
 */
export type CancelStream = {
  sessionId?: string;
  streamId?: string;
};
