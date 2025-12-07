import { describe, it, expect, beforeEach, vi } from "vitest";
import retrieveMessage from "../helpers/retrieveMessage";
import type QueueMessage from "../typeDefs/QueueMessage";
import type StravaEvent from "../typeDefs/StravaEvent";

const mocks = vi.hoisted(() => ({
    setMessageStartedMock: vi.fn(),
    completeMessageMock: vi.fn(),
    processCreateMock: vi.fn(),
    processUpdateMock: vi.fn(),
    processDeleteMock: vi.fn(),
}));

vi.mock("../helpers/setMessageStarted", () => ({
    default: mocks.setMessageStartedMock,
}));

vi.mock("../helpers/completeMessage", () => ({
    default: mocks.completeMessageMock,
}));

vi.mock("../helpers/processMessage", () => ({
    default: mocks.processCreateMock,
}));

vi.mock("../helpers/processUpdateMessage", () => ({
    default: mocks.processUpdateMock,
}));

vi.mock("../helpers/processDeleteMessage", () => ({
    default: mocks.processDeleteMock,
}));

const buildEvent = (overrides?: Partial<StravaEvent>): StravaEvent => ({
    aspect_type: "create",
    event_time: 0,
    object_id: 123,
    object_type: "activity",
    owner_id: 456,
    subscription_id: 1,
    updates: {},
    ...overrides,
});

const buildMessage = (
    action: QueueMessage["action"],
    overrides?: Partial<QueueMessage>
): QueueMessage => ({
    id: 1,
    action,
    json_data: buildEvent(),
    is_webhook: true,
    priority: 1,
    ...overrides,
});

describe("retrieveMessage", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns false and completes with error when json_data is missing", async () => {
        const message = buildMessage("create", { json_data: undefined });
        const result = await retrieveMessage(message);

        expect(result).toBe(false);
        expect(mocks.completeMessageMock).toHaveBeenCalledWith(
            message.id,
            "Missing json_data in message"
        );
        expect(mocks.setMessageStartedMock).not.toHaveBeenCalled();
    });

    it("routes create messages to processMessage with parsed event", async () => {
        mocks.processCreateMock.mockResolvedValueOnce({ success: true });
        const message = buildMessage("create");

        const result = await retrieveMessage(message);

        expect(result).toBe(true);
        expect(mocks.setMessageStartedMock).toHaveBeenCalledWith(message.id);
        expect(mocks.processCreateMock).toHaveBeenCalledWith(
            message,
            buildEvent()
        );
        expect(mocks.completeMessageMock).toHaveBeenCalledWith(
            message.id,
            undefined
        );
    });

    it("routes update messages to processUpdateMessage", async () => {
        mocks.processUpdateMock.mockResolvedValueOnce({ success: true });
        const message = buildMessage("update");

        const result = await retrieveMessage(message);

        expect(result).toBe(true);
        expect(mocks.processUpdateMock).toHaveBeenCalled();
    });

    it("routes delete messages to processDeleteMessage", async () => {
        mocks.processDeleteMock.mockResolvedValueOnce({ success: true });
        const message = buildMessage("delete");

        const result = await retrieveMessage(message);

        expect(result).toBe(true);
        expect(mocks.processDeleteMock).toHaveBeenCalled();
    });

    it("completes with error for invalid actions", async () => {
        const message = buildMessage("create", { action: "unknown" as any });

        const result = await retrieveMessage(message);

        expect(result).toBe(false);
        expect(mocks.completeMessageMock).toHaveBeenCalledWith(
            message.id,
            "Invalid action"
        );
    });
});

