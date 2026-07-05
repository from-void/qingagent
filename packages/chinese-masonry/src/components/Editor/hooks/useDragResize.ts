interface PointerSessionOptions {
  event: React.PointerEvent<HTMLElement>;
  onStart?: () => void;
  onMove: (dx: number, dy: number) => void;
  onEnd?: () => void;
}

export function beginPointerSession({ event, onStart, onMove, onEnd }: PointerSessionOptions) {
  event.preventDefault();
  event.stopPropagation();

  const getCoordinate = (value: number) => (Number.isFinite(value) ? value : 0);
  const startX = getCoordinate(event.clientX);
  const startY = getCoordinate(event.clientY);
  let lastX = startX;
  let lastY = startY;
  let started = false;

  const handleMove = (moveEvent: PointerEvent) => {
    const nextX = getCoordinate(moveEvent.clientX);
    const nextY = getCoordinate(moveEvent.clientY);
    const dx = nextX - lastX;
    const dy = nextY - lastY;
    if (dx === 0 && dy === 0) return;
    if (!started) {
      onStart?.();
      started = true;
    }
    lastX = nextX;
    lastY = nextY;
    onMove(dx, dy);
  };

  const handleUp = () => {
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);
    onEnd?.();
  };

  window.addEventListener('pointermove', handleMove);
  window.addEventListener('pointerup', handleUp, { once: true });
}
