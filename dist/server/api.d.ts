import type { Request, Response } from 'express';
import type { WebSocket } from 'ws';
export declare function handleChat(req: Request, res: Response): Promise<void>;
export declare function handleStream(req: Request, res: Response): void;
export declare function handleTodos(req: Request, res: Response): void;
export declare function handleStatus(req: Request, res: Response): void;
export declare function handleResume(req: Request, res: Response): void;
export declare function attachWebSocket(ws: WebSocket, sessionId: string): void;
//# sourceMappingURL=api.d.ts.map