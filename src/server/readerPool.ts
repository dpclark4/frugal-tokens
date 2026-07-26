type PoolTask<Request, Result> = {
  id: number;
  request: Request;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
};

type WorkerSlot<Request, Result> = {
  worker: Worker;
  ready: boolean;
  active?: PoolTask<Request, Result>;
};

type WorkerResponse<Result> =
  | { type: "ready" }
  | { type: "result"; id: number; result: Result }
  | { type: "error"; id?: number; message: string; stack?: string };

/** A bounded task pool for module workers that implement the reader protocol. */
export class ReaderPool<Request, Result> {
  readonly #slots: WorkerSlot<Request, Result>[] = [];
  readonly #queue: PoolTask<Request, Result>[] = [];
  #nextID = 1;
  #failure?: Error;
  #closed = false;

  constructor(
    size: number,
    createWorker: () => Worker,
    initialize: unknown,
  ) {
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError("reader pool size must be a positive integer");
    }

    try {
      for (let index = 0; index < size; index++) {
        const worker = createWorker();
        const slot: WorkerSlot<Request, Result> = { worker, ready: false };
        worker.onmessage = (event: MessageEvent<WorkerResponse<Result>>) => {
          this.#receive(slot, event.data);
        };
        worker.onerror = (event) => {
          event.preventDefault();
          this.#fail(new Error(event.message || "Reader worker failed"));
        };
        worker.onmessageerror = () => {
          this.#fail(new Error("Reader worker returned an invalid message"));
        };
        this.#slots.push(slot);
        worker.postMessage({ type: "initialize", value: initialize });
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  execute(request: Request): Promise<Result> {
    if (this.#closed) {
      return Promise.reject(new Error("Reader pool is closed"));
    }
    if (this.#failure) return Promise.reject(this.#failure);

    return new Promise((resolve, reject) => {
      this.#queue.push({ id: this.#nextID++, request, resolve, reject });
      this.#dispatch();
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    const error = this.#failure ?? new Error("Reader pool is closed");
    for (const slot of this.#slots) {
      slot.active?.reject(error);
      slot.worker.terminate();
    }
    for (const task of this.#queue.splice(0)) task.reject(error);
  }

  #receive(
    slot: WorkerSlot<Request, Result>,
    response: WorkerResponse<Result>,
  ) {
    if (this.#closed || this.#failure) return;
    if (response.type === "ready") {
      slot.ready = true;
      this.#dispatch();
      return;
    }
    if (response.type === "error" && response.id === undefined) {
      this.#fail(this.#error(response));
      return;
    }

    const task = slot.active;
    if (!task || response.id !== task.id) {
      this.#fail(new Error("Reader worker returned an unexpected response"));
      return;
    }
    slot.active = undefined;
    if (response.type === "result") task.resolve(response.result);
    else task.reject(this.#error(response));
    this.#dispatch();
  }

  #dispatch() {
    if (this.#closed || this.#failure) return;
    for (const slot of this.#slots) {
      if (!slot.ready || slot.active) continue;
      const task = this.#queue.shift();
      if (!task) return;
      slot.active = task;
      slot.worker.postMessage({
        type: "execute",
        id: task.id,
        request: task.request,
      });
    }
  }

  #fail(error: Error) {
    if (this.#failure || this.#closed) return;
    this.#failure = error;
    for (const slot of this.#slots) {
      slot.active?.reject(error);
      slot.active = undefined;
      slot.worker.terminate();
    }
    for (const task of this.#queue.splice(0)) task.reject(error);
  }

  #error(response: Extract<WorkerResponse<Result>, { type: "error" }>) {
    const error = new Error(response.message);
    if (response.stack) error.stack = response.stack;
    return error;
  }
}
