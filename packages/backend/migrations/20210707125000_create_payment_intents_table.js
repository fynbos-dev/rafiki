exports.up = function (knex) {
  return knex.schema.createTable('paymentIntents', function (table) {
    table.uuid('id').notNullable().primary()

    table.string('paymentPointer').nullable()
    table.string('invoiceUrl').nullable()
    table.bigInteger('amountToSend').nullable()

    table.timestamp('createdAt').defaultTo(knex.fn.now())
    table.timestamp('updatedAt').defaultTo(knex.fn.now())
  })
}

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('paymentIntents')
}
