/* Independent loopback interoperability fixture. Uses only disposable PSKs. */
#include <openssl/ssl.h>
#include <openssl/err.h>
#include <arpa/inet.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

static unsigned char psk_bytes[32];

static unsigned int peer_psk(SSL *ssl, const char *identity, unsigned char *output, unsigned int capacity) {
    (void)ssl;
    if (!identity || strcmp(identity, "AUTHPWD_admin") || capacity < sizeof(psk_bytes)) return 0;
    memcpy(output, psk_bytes, sizeof(psk_bytes));
    return sizeof(psk_bytes);
}

#define REQUIRE(condition) do { \
    if (!(condition)) { fprintf(stderr, "%s\n", #condition); ERR_print_errors_fp(stderr); return 1; } \
} while (0)

int main(int argc, char **argv) {
    REQUIRE(argc == 4 && strlen(argv[2]) == 64);
    for (int i = 0; i < 32; ++i) REQUIRE(sscanf(argv[2] + i * 2, "%2hhx", psk_bytes + i) == 1);
    int echoes = atoi(argv[3]);
    REQUIRE(echoes > 0 && echoes <= 4);
    int socket_fd = socket(AF_INET, SOCK_DGRAM, 0);
    REQUIRE(socket_fd >= 0);
    struct timeval timeout = {5, 0};
    REQUIRE(setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) == 0);
    struct sockaddr_in local = {.sin_family = AF_INET};
    REQUIRE(inet_pton(AF_INET, "127.0.0.1", &local.sin_addr) == 1);
    REQUIRE(bind(socket_fd, (struct sockaddr *)&local, sizeof(local)) == 0);
    socklen_t length = sizeof(local);
    REQUIRE(getsockname(socket_fd, (struct sockaddr *)&local, &length) == 0);

    SSL_CTX *ctx = SSL_CTX_new(DTLS_server_method());
    REQUIRE(ctx);
    REQUIRE(SSL_CTX_set_min_proto_version(ctx, DTLS1_2_VERSION) == 1);
    REQUIRE(SSL_CTX_set_max_proto_version(ctx, DTLS1_2_VERSION) == 1);
    REQUIRE(SSL_CTX_set_cipher_list(ctx, argv[1]) == 1);
    REQUIRE(SSL_CTX_set1_groups_list(ctx, "X25519") == 1);
    SSL_CTX_set_psk_server_callback(ctx, peer_psk);
    printf("%d\n", ntohs(local.sin_port));
    fflush(stdout);

    /* Bambu's IOTC path already selected and bound the peer. No DTLS cookie exchange. */
    struct sockaddr_in peer;
    length = sizeof(peer);
    unsigned char packet[65536];
    REQUIRE(recvfrom(socket_fd, packet, sizeof(packet), MSG_PEEK, (struct sockaddr *)&peer, &length) >= 0);
    REQUIRE(connect(socket_fd, (struct sockaddr *)&peer, length) == 0);
    BIO *bio = BIO_new_dgram(socket_fd, BIO_NOCLOSE);
    REQUIRE(bio);
    REQUIRE(BIO_ctrl(bio, BIO_CTRL_DGRAM_SET_CONNECTED, 0, &peer) == 1);
    SSL *ssl = SSL_new(ctx);
    REQUIRE(ssl);
    SSL_set_bio(ssl, bio, bio);
    REQUIRE(SSL_accept(ssl) == 1);
    for (int i = 0; i < echoes; ++i) {
        int received = SSL_read(ssl, packet, sizeof(packet));
        REQUIRE(received > 0);
        REQUIRE(SSL_write(ssl, packet, received) == received);
    }
    SSL_free(ssl);
    SSL_CTX_free(ctx);
    close(socket_fd);
    return 0;
}
