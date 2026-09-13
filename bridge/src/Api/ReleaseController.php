<?php

namespace Popoopendoor\CanvasMoneyBridge\Api;

use Flarum\User\User;

final class ReleaseController extends AbstractCanvasController
{
    protected function execute(array $body): array
    {
        $taskId = $this->taskId($body);
        $userId = $this->userId($body);
        $amount = $this->amount($body);
        $requestHash = $this->requestHash($body);

        return $this->db->transaction(function () use ($taskId, $userId, $amount, $requestHash): array {
            // Match HoldController's user -> ledger lock order to avoid a
            // release/hold deadlock for the same user and task.
            $user = User::query()->whereKey($userId)->lockForUpdate()->first();
            if (!$user) {
                throw new CanvasBridgeException(404, 'user_not_found');
            }
            $ledger = $this->db->table('canvas_money_ledgers')->where('task_id', $taskId)->lockForUpdate()->first();
            if (!$ledger) {
                throw new CanvasBridgeException(404, 'ledger_not_found');
            }
            $this->assertSameLedger($ledger, $userId, $amount, $requestHash);
            if ($ledger->status === 'released') {
                return ['ok' => true, 'ledgerId' => $ledger->id, 'status' => 'released'];
            }
            if ($ledger->status !== 'held') {
                throw new CanvasBridgeException(409, 'ledger_not_held');
            }
            $balance = $this->integerBalance($user);
            if ($amount > PHP_INT_MAX - $balance) {
                throw new CanvasBridgeException(409, 'wallet_balance_overflow');
            }
            $user->money = $balance + $amount;
            $user->save();
            $this->db->table('canvas_money_ledgers')->where('id', $ledger->id)->where('status', 'held')->update(['status' => 'released', 'updated_at' => time()]);

            return ['ok' => true, 'ledgerId' => $ledger->id, 'status' => 'released'];
        });
    }
}
