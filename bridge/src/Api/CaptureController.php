<?php

namespace Popoopendoor\CanvasMoneyBridge\Api;

final class CaptureController extends AbstractCanvasController
{
    protected function execute(array $body): array
    {
        $taskId = $this->taskId($body);
        $userId = $this->userId($body);
        $amount = $this->amount($body);
        $requestHash = $this->requestHash($body);
        return $this->db->transaction(function () use ($taskId, $userId, $amount, $requestHash): array {
            $ledger = $this->db->table('canvas_money_ledgers')->where('task_id', $taskId)->lockForUpdate()->first();
            if (!$ledger) {
                throw new CanvasBridgeException(404, 'ledger_not_found');
            }
            $this->assertSameLedger($ledger, $userId, $amount, $requestHash);
            if ($ledger->status === 'captured') {
                return ['ok' => true, 'ledgerId' => $ledger->id, 'status' => 'captured'];
            }
            if ($ledger->status !== 'held') {
                throw new CanvasBridgeException(409, 'ledger_not_held');
            }
            $this->db->table('canvas_money_ledgers')->where('id', $ledger->id)->where('status', 'held')->update(['status' => 'captured', 'updated_at' => time()]);

            return ['ok' => true, 'ledgerId' => $ledger->id, 'status' => 'captured'];
        });
    }
}
