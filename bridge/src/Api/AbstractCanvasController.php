<?php

namespace Popoopendoor\CanvasMoneyBridge\Api;

use Flarum\Settings\SettingsRepositoryInterface;
use Illuminate\Database\ConnectionInterface;
use Laminas\Diactoros\Response\JsonResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use RuntimeException;

abstract class AbstractCanvasController implements RequestHandlerInterface
{
    public function __construct(
        protected ConnectionInterface $db,
        protected SettingsRepositoryInterface $settings,
    ) {
    }

    public function handle(ServerRequestInterface $request): ResponseInterface
    {
        try {
            $this->authorizeService($request);
            return new JsonResponse($this->execute($this->body($request)));
        } catch (CanvasBridgeException $error) {
            return new JsonResponse(['ok' => false, 'error' => $error->getMessage()], $error->status);
        }
    }

    abstract protected function execute(array $body): array;

    protected function body(ServerRequestInterface $request): array
    {
        $parsed = $request->getParsedBody();
        if (!is_array($parsed)) {
            throw new CanvasBridgeException(400, 'invalid_json');
        }

        return $parsed;
    }

    protected function authorizeService(ServerRequestInterface $request): void
    {
        $configured = trim((string) $this->settings->get('popoopendoor-canvas-money-bridge.service-token'));
        $provided = trim($request->getHeaderLine('X-Canvas-Bridge-Token'));
        if ($configured === '' || $provided === '' || !hash_equals($configured, $provided)) {
            throw new CanvasBridgeException(401, 'service_unauthorized');
        }
    }

    protected function userId(array $body): int
    {
        $value = $body['userId'] ?? null;
        if (is_string($value) && ctype_digit($value)) {
            $value = (int) $value;
        }
        if (!is_int($value) || $value < 1) {
            throw new CanvasBridgeException(400, 'invalid_user_id');
        }

        return $value;
    }

    protected function amount(array $body): int
    {
        $value = $body['amount'] ?? null;
        if (!is_int($value) || $value < 0) {
            throw new CanvasBridgeException(400, 'invalid_amount');
        }
        return $value;
    }

    protected function assertSameLedger(object $ledger, int $userId, int $amount, string $requestHash): void
    {
        if ((int) $ledger->user_id !== $userId || (int) $ledger->amount !== $amount || !hash_equals($ledger->request_hash, $requestHash)) {
            throw new CanvasBridgeException(409, 'ledger_replay_conflict');
        }
    }

    protected function taskId(array $body): string
    {
        $taskId = $body['taskId'] ?? '';
        if (!is_string($taskId) || !preg_match('/^[A-Za-z0-9_-]{8,200}$/', $taskId)) {
            throw new CanvasBridgeException(400, 'invalid_task_id');
        }

        return $taskId;
    }

    protected function requestHash(array $body): string
    {
        $hash = $body['requestHash'] ?? '';
        if (!is_string($hash) || !preg_match('/^[a-f0-9]{64}$/', $hash)) {
            throw new CanvasBridgeException(400, 'invalid_request_hash');
        }

        return $hash;
    }

    protected function integerBalance(object $user): int
    {
        $balance = (float) $user->money;
        if (!is_finite($balance) || floor($balance) !== $balance || $balance < 0 || $balance > PHP_INT_MAX) {
            throw new CanvasBridgeException(409, 'wallet_balance_is_not_a_non_negative_integer');
        }

        return (int) $balance;
    }
}

final class CanvasBridgeException extends RuntimeException
{
    public function __construct(public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}
