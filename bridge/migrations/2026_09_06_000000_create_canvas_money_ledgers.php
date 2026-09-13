<?php

use Flarum\Database\Migration;
use Illuminate\Database\Schema\Blueprint;

return Migration::createTable(
    'canvas_money_ledgers',
    function (Blueprint $table): void {
        $table->increments('id');
        $table->string('task_id', 200)->unique();
        $table->unsignedInteger('user_id')->index();
        $table->unsignedBigInteger('amount');
        $table->char('request_hash', 64);
        $table->string('status', 32);
        $table->unsignedInteger('created_at');
        $table->unsignedInteger('updated_at');
        $table->index(['user_id', 'status']);
    },
);
