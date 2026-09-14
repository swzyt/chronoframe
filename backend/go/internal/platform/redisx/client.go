package redisx

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const refreshRuntimeLeaseScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`

const releaseRuntimeLeaseScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

const rateLimitAcquireScript = `
local current = redis.call('GET', KEYS[1])
if current and tonumber(current) >= tonumber(ARGV[1]) then
  local ttl = redis.call('TTL', KEYS[1])
  if ttl < 0 then
    redis.call('EXPIREAT', KEYS[1], ARGV[2])
    ttl = redis.call('TTL', KEYS[1])
  end
  return {0, tonumber(current), ttl}
end

local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIREAT', KEYS[1], ARGV[2])
end
return {1, count, redis.call('TTL', KEYS[1])}
`

type Client struct {
	redis *redis.Client
}

func New(rawURL, username, password string) (*Client, error) {
	if strings.TrimSpace(rawURL) == "" {
		return nil, errors.New("Redis URL must not be empty")
	}
	options, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, fmt.Errorf("parse Redis URL: %w", err)
	}
	if username != "" {
		options.Username = username
	}
	if password != "" {
		options.Password = password
	}
	return &Client{redis: redis.NewClient(options)}, nil
}

func (c *Client) Close() error {
	return c.redis.Close()
}

func (c *Client) Ping(ctx context.Context) error {
	if err := c.redis.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("ping Redis: %w", err)
	}
	return nil
}

func (c *Client) GetString(ctx context.Context, key string) (string, error) {
	value, err := c.redis.Get(ctx, key).Result()
	if err != nil {
		return "", err
	}
	return value, nil
}

func (c *Client) Incr(ctx context.Context, key string) (int64, error) {
	value, err := c.redis.Incr(ctx, key).Result()
	if err != nil {
		return 0, fmt.Errorf("increment Redis key %s: %w", key, err)
	}
	return value, nil
}

func (c *Client) TryAcquireRuntimeLease(ctx context.Context, key string, value string, ttl time.Duration) (bool, error) {
	acquired, err := c.redis.SetNX(ctx, key, value, ttl).Result()
	if err != nil {
		return false, fmt.Errorf("acquire runtime lease %s: %w", key, err)
	}
	return acquired, nil
}

func (c *Client) RefreshRuntimeLease(ctx context.Context, key string, value string, ttl time.Duration) (bool, error) {
	result, err := c.redis.Eval(ctx, refreshRuntimeLeaseScript, []string{key}, value, strconv.FormatInt(ttl.Milliseconds(), 10)).Int64()
	if err != nil {
		return false, fmt.Errorf("refresh runtime lease %s: %w", key, err)
	}
	return result == 1, nil
}

func (c *Client) ReleaseRuntimeLease(ctx context.Context, key string, value string) error {
	if err := c.redis.Eval(ctx, releaseRuntimeLeaseScript, []string{key}, value).Err(); err != nil {
		return fmt.Errorf("release runtime lease %s: %w", key, err)
	}
	return nil
}

func (c *Client) AcquireRateLimit(ctx context.Context, key string, maxAttempts int64, windowExpiresAt int64) (bool, int64, int64, error) {
	result, err := c.redis.Eval(
		ctx,
		rateLimitAcquireScript,
		[]string{key},
		strconv.FormatInt(maxAttempts, 10),
		strconv.FormatInt(windowExpiresAt, 10),
	).Slice()
	if err != nil {
		return false, 0, 0, fmt.Errorf("acquire rate limit %s: %w", key, err)
	}
	if len(result) != 3 {
		return false, 0, 0, fmt.Errorf("acquire rate limit %s: unexpected result shape", key)
	}
	allowed, ok := redisScriptInt64(result[0])
	if !ok {
		return false, 0, 0, fmt.Errorf("acquire rate limit %s: invalid allowed value", key)
	}
	count, ok := redisScriptInt64(result[1])
	if !ok {
		return false, 0, 0, fmt.Errorf("acquire rate limit %s: invalid count value", key)
	}
	retryAfter, ok := redisScriptInt64(result[2])
	if !ok {
		return false, 0, 0, fmt.Errorf("acquire rate limit %s: invalid retry-after value", key)
	}
	if retryAfter < 1 {
		retryAfter = 1
	}
	return allowed == 1, count, retryAfter, nil
}

func (c *Client) ResetRateLimit(ctx context.Context, key string) error {
	if err := c.redis.Del(ctx, key).Err(); err != nil {
		return fmt.Errorf("reset rate limit %s: %w", key, err)
	}
	return nil
}

func (c *Client) Raw() *redis.Client {
	return c.redis
}

func redisScriptInt64(value any) (int64, bool) {
	switch typed := value.(type) {
	case int64:
		return typed, true
	case int:
		return int64(typed), true
	case string:
		parsed, err := strconv.ParseInt(typed, 10, 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}
