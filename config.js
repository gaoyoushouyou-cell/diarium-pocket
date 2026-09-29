/*
 * Diarium Pocket の設定。
 * clientId には、Microsoft Entra で登録したアプリの「アプリケーション (クライアント) ID」を入れる
 * (README の手順 2)。空のままでも、共有シートで OneDrive に保存する方法は使える。
 * クライアントIDは秘密の値ではない(公開してよい)。
 */
window.POCKET_CONFIG = {
  clientId: "",
};
