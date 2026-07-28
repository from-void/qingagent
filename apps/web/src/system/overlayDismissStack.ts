// 浮层关闭栈:设置弹层内的所有浮层(档位 chip 菜单 / SkinSelect 下拉 / 日历 / 技能行右键菜单)
// 开启时向本栈注册"关自己"的回调,关闭或卸载时注销。
//
// 为什么要有它:Esc 关浮层原本各控件自己在 keydown 里做,只有焦点恰好落在触发器上才生效;
// 焦点在别处(例如点开菜单后 activeElement 掉回 body)时按 Esc 就无人响应——菜单不关,
// 面板级守卫又因"检测到浮层还开着"而不关面板,结果整个 Esc 完全无操作(luna e2e 实锤)。
//
// 现在收敛成单一出口:面板级 Esc 守卫先问本栈,栈非空就弹栈关掉最上层浮层并消费掉事件;
// 栈空才按原语义关设置面板。关闭动作由浮层自己注册的回调执行(含把焦点还回触发器)。
import { useEffect, useRef } from "react";

export type OverlayDismiss = () => void;

interface OverlayEntry {
  dismiss: OverlayDismiss;
}

// 后进先出:最后打开的浮层排在栈顶,Esc 先关它
const stack: OverlayEntry[] = [];

/** 注册一个可被 Esc 关闭的浮层,返回注销函数(幂等) */
export function registerOverlay(dismiss: OverlayDismiss): () => void {
  const entry: OverlayEntry = { dismiss };
  stack.push(entry);
  return () => {
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
  };
}

/** 当前是否还有浮层开着 */
export function hasOpenOverlay(): boolean {
  return stack.length > 0;
}

/** 关掉最上层浮层;栈空返回 false,调用方据此决定要不要继续走原语义 */
export function dismissTopOverlay(): boolean {
  const entry = stack.pop();
  if (!entry) return false;
  entry.dismiss();
  return true;
}

/** 测试夹具:用例之间清干净,避免上一条用例的残留浮层影响下一条 */
export function resetOverlayDismissStackForTest(): void {
  stack.length = 0;
}

/**
 * 浮层侧接线:open 为真期间把 dismiss 挂进栈。
 * dismiss 走 ref 转发,注册后仍能拿到最新一次渲染的闭包,不必因回调变化反复重注册。
 */
export function useOverlayDismiss(open: boolean, dismiss: OverlayDismiss): void {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    if (!open) return;
    return registerOverlay(() => dismissRef.current());
  }, [open]);
}
