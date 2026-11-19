set -euo pipefail

awslocal sqs create-queue \
    --queue-name wager-transactions-dlq.fifo
    --attributes FifoQueue=true

DLQ_URL=$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" \
    --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

cat > /tmp/main-attrs/json <<EOF
{
    "FifoQueue": "true",
    "ContentBasedDeduplication": "false",
    "VisibilityTimeout": "30",
    "RedrivePolicy": "{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"5\"}"
}
EOF
awslocal sqs create-queue \
    --queue-name wager-transactions.fifo \
    --attributes file:///tmp/main-attrs/json

awslocal sqs create-queue \
    --queue-name wager-events.fifo \
    --attributes FifoQueue=true, ContentBasedDeduplication=false
