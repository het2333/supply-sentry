"""Publish a loopback-only Hermes Dashboard through Docker port forwarding."""

from __future__ import annotations

import argparse
import asyncio


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(64 * 1024):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        try:
            writer.write_eof()
        except (AttributeError, ConnectionError, OSError):
            pass


async def _forward(
    client_reader: asyncio.StreamReader,
    client_writer: asyncio.StreamWriter,
    upstream_host: str,
    upstream_port: int,
) -> None:
    try:
        upstream_reader, upstream_writer = await asyncio.open_connection(
            upstream_host, upstream_port
        )
    except (ConnectionError, OSError):
        client_writer.close()
        await client_writer.wait_closed()
        return
    try:
        await asyncio.gather(
            _pipe(client_reader, upstream_writer),
            _pipe(upstream_reader, client_writer),
        )
    finally:
        upstream_writer.close()
        client_writer.close()
        await asyncio.gather(
            upstream_writer.wait_closed(),
            client_writer.wait_closed(),
            return_exceptions=True,
        )


async def start_proxy(
    listen_host: str,
    listen_port: int,
    upstream_host: str,
    upstream_port: int,
) -> asyncio.Server:
    return await asyncio.start_server(
        lambda reader, writer: _forward(
            reader, writer, upstream_host, upstream_port
        ),
        listen_host,
        listen_port,
    )


async def _main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen-host", default="0.0.0.0")
    parser.add_argument("--listen-port", type=int, default=9119)
    parser.add_argument("--upstream-host", default="127.0.0.1")
    parser.add_argument("--upstream-port", type=int, default=9120)
    args = parser.parse_args()
    server = await start_proxy(
        args.listen_host,
        args.listen_port,
        args.upstream_host,
        args.upstream_port,
    )
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(_main())
