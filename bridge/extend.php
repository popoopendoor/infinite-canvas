<?php

use Flarum\Extend;
use Popoopendoor\CanvasMoneyBridge\Api\BalanceController;
use Popoopendoor\CanvasMoneyBridge\Api\CaptureController;
use Popoopendoor\CanvasMoneyBridge\Api\HoldController;
use Popoopendoor\CanvasMoneyBridge\Api\ReleaseController;

return [
    (new Extend\Routes('api'))
        ->post('/canvas-money/balance', 'canvas-money.balance', BalanceController::class)
        ->post('/canvas-money/hold', 'canvas-money.hold', HoldController::class)
        ->post('/canvas-money/capture', 'canvas-money.capture', CaptureController::class)
        ->post('/canvas-money/release', 'canvas-money.release', ReleaseController::class),
    (new Extend\Csrf())
        ->exemptRoute('canvas-money.balance')
        ->exemptRoute('canvas-money.hold')
        ->exemptRoute('canvas-money.capture')
        ->exemptRoute('canvas-money.release'),
    (new Extend\Settings())
        ->default('popoopendoor-canvas-money-bridge.service-token', ''),
];
