import { createHeartbeatEvent, subscribeToRunEvents } from "@/backend/workflow-events";
import { getContractVersion } from "@/backend/workflow-engine";
import type { WorkflowEvent } from "@/contracts/workflow-contract";

interface RouteParams {
  params: Promise<{ runId: string }>;
}

function serializeSse(eventName: string, payload: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export async function GET(_: Request, { params }: RouteParams) {
  const { runId } = await params;
  const encoder = new TextEncoder();
  let heartbeatSequence = 0;
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (unsubscribe) unsubscribe();
  };

  const enqueueEvent = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: WorkflowEvent,
  ): boolean => {
    if (closed) return false;
    try {
      controller.enqueue(encoder.encode(serializeSse(event.eventType, event)));
      return true;
    } catch {
      cleanup();
      return false;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      heartbeatSequence += 1;
      enqueueEvent(controller, createHeartbeatEvent(runId, heartbeatSequence));

      heartbeatInterval = setInterval(() => {
        heartbeatSequence += 1;
        enqueueEvent(controller, createHeartbeatEvent(runId, heartbeatSequence));
      }, 5000);

      unsubscribe = subscribeToRunEvents(runId, (event) => {
        enqueueEvent(controller, event);
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-contract-version": getContractVersion(),
    },
  });
}
