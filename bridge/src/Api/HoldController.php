<?php

namespace Popoopendoor\CanvasMoneyBridge\Api;

use Flarum\User\User;

final class HoldController extends AbstractCanvasController
{
    protected function execute(array $body): array
    {
        $userId = $this->userId($body);
        $taskId = $this->taskId($body);
        $amount = $this->amount($body);
        $requestHash = $this->requestHash($body);

        return $this->db->transaction(function () use ($userId, $taskId, $amount, $requestHash): array {
            $existing = $this->db->table('canvas_money_ledgers')->where('task_id', $taskId)->first();
            if ($existing) {
                $this->assertSameLedger($existing, $userId, $amount, $requestHash);
                if ($existing->status === 'held' || $existing->status === 'captured') {
                    return ['ok' => true, 'ledgerId' => $existing->id, 'status' => $existing->status];
                }
                throw new CanvasBridgeException(409, 'ledger_already_released');
            }

            $user = User::query()->whereKey($userId)->lockForUpdate()->first();
            if (!$user) {
                throw new CanvasBridgeException(404, 'user_not_found');
            }

            // Re-read under the user lock so concurrent retries observe a committed ledger.
            $existing = $this->db->table('canvas_money_ledgers')->where('task_id', $taskId)->lockForUpdate()->first();
            if ($existing) {
                $this->assertSameLedger($existing, $userId, $amount, $requestHash);
                if ($existing->status === 'held' || $existing->status === 'captured') {
                    return ['ok' => true, 'ledgerId' => $existing->id, 'status' => $existing->status];
                }
                throw new CanvasBridgeException(409, 'ledger_already_released');
            }
            $balance = $this->integerBalance($user);
            if ($amount > $balance) {
                throw new CanvasBridgeException(409, 'insufficient_balance');
            }
            if ($amount > PHP_INT_MAX - $balance) {
                throw new CanvasBridgeException(409, 'wallet_balance_overflow');
            }
            $user->money = $balance - $amount;
            $user->save();
            $ledgerId = (int) $this->db->table('canvas_money_ledgers')->insertGetId([
                'task_id' => $taskId,
                'user_id' => $userId,
                'amount' => $amount,
                'request_hash' => $requestHash,
                'status' => 'held',
                'created_at' => time(),
                'updated_at' => time(),
            ]);

            return ['ok' => true, 'ledgerId' => $ledgerId, 'status' => 'held'];
        });
    }

}
