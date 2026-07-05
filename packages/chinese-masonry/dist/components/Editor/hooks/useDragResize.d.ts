interface PointerSessionOptions {
    event: React.PointerEvent<HTMLElement>;
    onStart?: () => void;
    onMove: (dx: number, dy: number) => void;
    onEnd?: () => void;
}
export declare function beginPointerSession({ event, onStart, onMove, onEnd }: PointerSessionOptions): void;
export {};
//# sourceMappingURL=useDragResize.d.ts.map