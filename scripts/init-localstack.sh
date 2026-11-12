#!/bin/sh
set -eu

until awslocal sqs list-queues >/dev/null 2>&1; do
  sleep 1
done

awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}'

DLQ_ARN="arn:aws:sqs:us-east-1:000000000000:wager-transactions-dlq.fifo"
REDRIVE_POLICY=$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"5"}' "$DLQ_ARN")
REDRIVE_JSON=$(printf '%s' "$REDRIVE_POLICY" | python -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
ATTRIBUTES=$(printf '{"FifoQueue":"true","ContentBasedDeduplication":"false","RedrivePolicy":%s}' "$REDRIVE_JSON")
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "$ATTRIBUTES"

awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}'
