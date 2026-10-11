/** Cancel crossed points instead of queuing tooltip updates for each one. */
export function hoverIntent<T>(
  show: (value: T | undefined) => void,
  delay = 75,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  function cancel() {
    clearTimeout(timer);
    timer = undefined;
  }
  return {
    enter(value: T, immediate = false) {
      cancel();
      if (immediate) show(value);
      else {timer = setTimeout(() => {
          timer = undefined;
          show(value);
        }, delay);}
    },
    leave() {
      cancel();
      show(undefined);
    },
    cancel,
  };
}
