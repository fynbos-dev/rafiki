exports.up = function (knex) {
  return knex.schema.createTable('paymentProgress', function (table) {
    table.uuid('id').notNullable().primary() // This is identical to OutgoingPayment.id

    // XXX TODO fetching the OutgoingPayment should have up-to-date outcome amounts... join?
    table.bigInteger('amountSent').notNullable()
    table.bigInteger('amountDelivered').notNullable()

    table.timestamp('createdAt').defaultTo(knex.fn.now())
    table.timestamp('updatedAt').defaultTo(knex.fn.now())
  })
}

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('paymentProgress')
}
