<?php

namespace Popoopendoor\CanvasMoneyBridge\Api;

use Flarum\User\User;

final class BalanceController extends AbstractCanvasController
{
    protected function execute(array $body): array
    {
        $user = User::query()->find($this->userId($body));
        if (!$user) {
            throw new CanvasBridgeException(404, 'user_not_found');
        }

        return ['ok' => true, 'balance' => $this->integerBalance($user)];
    }
}
